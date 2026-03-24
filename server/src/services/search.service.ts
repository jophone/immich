import { BadRequestException, Injectable } from '@nestjs/common';
import { LRUMap } from 'mnemonist';
import { AssetMapOptions, AssetResponseDto, MapAsset, mapAsset } from 'src/dtos/asset-response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { mapPerson, PersonResponseDto } from 'src/dtos/person.dto';
import {
    LargeAssetSearchDto,
    LiteSearchDto,
    mapPlaces,
    MetadataSearchDto,
    PlacesResponseDto,
    RandomSearchDto,
    SearchPeopleDto,
    SearchPlacesDto,
    SearchResponseDto,
    SearchStatisticsResponseDto,
    SearchSuggestionRequestDto,
    SearchSuggestionType,
    SmartSearchDto,
    StatisticsSearchDto,
} from 'src/dtos/search.dto';
import { AssetOrder, AssetVisibility, Permission } from 'src/enum';
import { BaseService } from 'src/services/base.service';
import { requireElevatedPermission } from 'src/utils/access';
import { getMyPartnerIds } from 'src/utils/asset.util';
import {
    getCategoryHierarchy,
    getKnownRawCategoryNames,
    getRawCategoriesByHierarchy,
    shouldIncludeUnmappedCategories,
} from 'src/utils/category-taxonomy';
import { isLiteSearchEnabled, isSmartSearchEnabled } from 'src/utils/misc';

@Injectable()
export class SearchService extends BaseService {
  private embeddingCache = new LRUMap<string, string>(100);

  async searchPerson(auth: AuthDto, dto: SearchPeopleDto): Promise<PersonResponseDto[]> {
    const people = await this.personRepository.getByName(auth.user.id, dto.name, { withHidden: dto.withHidden });
    return people.map((person) => mapPerson(person));
  }

  async searchPlaces(dto: SearchPlacesDto): Promise<PlacesResponseDto[]> {
    const places = await this.searchRepository.searchPlaces(dto.name);
    return places.map((place) => mapPlaces(place));
  }

  async getExploreData(auth: AuthDto) {
    const cityOptions = { maxFields: 12, minAssetsPerField: 5 };
    const categoryOptions = { minAssetsPerField: 1 };
    const emptyResult = { fieldName: 'category' as const, items: [] as { value: string; data: string }[] };

    const [cities, categories] = await Promise.all([
      this.assetRepository.getAssetIdByCity(auth.user.id, cityOptions),
      this.categoryRepository.getTopCategoriesWithAsset(auth.user.id, categoryOptions).catch((error) => {
        this.logger.warn(`Failed to get categories for explore page: ${error}`);
        return emptyResult;
      }),
    ]);

    const categoryL1ById = new Map<string, { value: string; data: string; labelZh: string; labelEn: string }>();
    const categoryL2ById = new Map<
      string,
      {
        value: string;
        data: string;
        labelZh: string;
        labelEn: string;
        parentValue: string;
        parentLabelZh: string;
        parentLabelEn: string;
      }
    >();

    for (const item of categories.items) {
      const hierarchy = getCategoryHierarchy(item.value);

      if (!categoryL1ById.has(hierarchy.l1.id)) {
        categoryL1ById.set(hierarchy.l1.id, {
          value: hierarchy.l1.id,
          data: item.data,
          labelZh: hierarchy.l1.nameZh,
          labelEn: hierarchy.l1.nameEn,
        });
      }

      if (!categoryL2ById.has(hierarchy.l2.id)) {
        categoryL2ById.set(hierarchy.l2.id, {
          value: hierarchy.l2.id,
          data: item.data,
          labelZh: hierarchy.l2.nameZh,
          labelEn: hierarchy.l2.nameEn,
          parentValue: hierarchy.l1.id,
          parentLabelZh: hierarchy.l1.nameZh,
          parentLabelEn: hierarchy.l1.nameEn,
        });
      }
    }

    const categoryL1Items = [...categoryL1ById.values()];
    const categoryL2Items = [...categoryL2ById.values()];

    const allAssetIds = [
      ...cities.items.map(({ data }) => data),
      ...categoryL1Items.map(({ data }) => data),
      ...categoryL2Items.map(({ data }) => data),
    ];
    const uniqueAssetIds = [...new Set(allAssetIds)];
    const assets = await this.assetRepository.getByIdsWithAllRelationsButStacks(uniqueAssetIds);
    const assetMap = new Map(assets.map((asset) => [asset.id, asset]));

    const cityItems = cities.items
      .filter(({ data }) => assetMap.has(data))
      .map(({ value, data }) => ({ value, data: mapAsset(assetMap.get(data)!, { auth }) }));

    const result = [{ fieldName: cities.fieldName, items: cityItems }];

    const categoryL1ExploreItems = categoryL1Items
      .filter(({ data }) => assetMap.has(data))
      .map(({ value, data, labelZh, labelEn }) => ({
        value,
        data: mapAsset(assetMap.get(data)!, { auth }),
        labelZh,
        labelEn,
      }));

    if (categoryL1ExploreItems.length > 0) {
      result.push({ fieldName: 'categoryL1', items: categoryL1ExploreItems });
    }

    const categoryL2ExploreItems = categoryL2Items
      .filter(({ data }) => assetMap.has(data))
      .map(({ value, data, labelZh, labelEn, parentValue, parentLabelZh, parentLabelEn }) => ({
        value,
        data: mapAsset(assetMap.get(data)!, { auth }),
        labelZh,
        labelEn,
        parentValue,
        parentLabelZh,
        parentLabelEn,
      }));

    if (categoryL2ExploreItems.length > 0) {
      result.push({ fieldName: 'categoryL2', items: categoryL2ExploreItems });
    }

    return result;
  }

  async searchMetadata(auth: AuthDto, dto: MetadataSearchDto): Promise<SearchResponseDto> {
    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    let checksum: Buffer | undefined;
    if (dto.checksum) {
      const encoding = dto.checksum.length === 28 ? 'base64' : 'hex';
      checksum = Buffer.from(dto.checksum, encoding);
    }

    const page = dto.page ?? 1;
    const size = dto.size || 250;
    const userIds = await this.getUserIdsToSearch(auth);
    const searchOptions = this.withExpandedCategoryFilters(dto);
    const { hasNextPage, items } = await this.searchRepository.searchMetadata(
      { page, size },
      {
        ...searchOptions,
        checksum,
        userIds,
        orderDirection: dto.order ?? AssetOrder.Desc,
      },
    );

    return this.mapResponse(items, hasNextPage ? (page + 1).toString() : null, { auth });
  }

  async searchStatistics(auth: AuthDto, dto: StatisticsSearchDto): Promise<SearchStatisticsResponseDto> {
    const userIds = await this.getUserIdsToSearch(auth);
    const searchOptions = this.withExpandedCategoryFilters(dto);

    return await this.searchRepository.searchStatistics({
      ...searchOptions,
      userIds,
    });
  }

  async searchRandom(auth: AuthDto, dto: RandomSearchDto): Promise<AssetResponseDto[]> {
    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    const userIds = await this.getUserIdsToSearch(auth);
    const searchOptions = this.withExpandedCategoryFilters(dto);
    const items = await this.searchRepository.searchRandom(dto.size || 250, { ...searchOptions, userIds });
    return items.map((item) => mapAsset(item, { auth }));
  }

  async searchLargeAssets(auth: AuthDto, dto: LargeAssetSearchDto): Promise<AssetResponseDto[]> {
    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    const userIds = await this.getUserIdsToSearch(auth);
    const searchOptions = this.withExpandedCategoryFilters(dto);
    const items = await this.searchRepository.searchLargeAssets(dto.size || 250, { ...searchOptions, userIds });
    return items.map((item) => mapAsset(item, { auth }));
  }

  async searchSmart(auth: AuthDto, dto: SmartSearchDto): Promise<SearchResponseDto> {
    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isSmartSearchEnabled(machineLearning)) {
      throw new BadRequestException('Smart search is not enabled');
    }

    const userIds = this.getUserIdsToSearch(auth);
    let embedding;
    if (dto.query) {
      const key = machineLearning.clip.modelName + dto.query + dto.language;
      embedding = this.embeddingCache.get(key);
      if (!embedding) {
        embedding = await this.machineLearningRepository.encodeText(dto.query, {
          modelName: machineLearning.clip.modelName,
          language: dto.language,
        });
        this.embeddingCache.set(key, embedding);
      }
    } else if (dto.queryAssetId) {
      await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [dto.queryAssetId] });
      const getEmbeddingResponse = await this.searchRepository.getEmbedding(dto.queryAssetId);
      const assetEmbedding = getEmbeddingResponse?.embedding;
      if (!assetEmbedding) {
        throw new BadRequestException(`Asset ${dto.queryAssetId} has no embedding`);
      }
      embedding = assetEmbedding;
    } else {
      throw new BadRequestException('Either `query` or `queryAssetId` must be set');
    }
    const page = dto.page ?? 1;
    const size = dto.size || 100;
    const searchOptions = this.withExpandedCategoryFilters(dto);
    const { hasNextPage, items } = await this.searchRepository.searchSmart(
      { page, size },
      { ...searchOptions, userIds: await userIds, embedding },
    );

    return this.mapResponse(items, hasNextPage ? (page + 1).toString() : null, { auth });
  }

  async searchLite(auth: AuthDto, dto: LiteSearchDto): Promise<SearchResponseDto> {
    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isLiteSearchEnabled(machineLearning)) {
      throw new BadRequestException('Lite search is not enabled');
    }

    const userIds = this.getUserIdsToSearch(auth);

    const key = machineLearning.liteSearch.modelName + dto.query + (dto.language || '');
    let embedding = this.embeddingCache.get(key);
    if (!embedding) {
      embedding = await this.machineLearningRepository.encodeLiteText(dto.query, machineLearning.liteSearch);
      this.embeddingCache.set(key, embedding);
    }

    const page = dto.page ?? 1;
    const size = dto.size || 100;
    const searchOptions = this.withExpandedCategoryFilters(dto);
    const { hasNextPage, items } = await this.searchRepository.searchLite(
      { page, size },
      { ...searchOptions, userIds: await userIds, embedding },
    );

    return this.mapResponse(items, hasNextPage ? (page + 1).toString() : null, { auth });
  }

  async getAssetsByCity(auth: AuthDto): Promise<AssetResponseDto[]> {
    const userIds = await this.getUserIdsToSearch(auth);
    const assets = await this.searchRepository.getAssetsByCity(userIds);
    return assets.map((asset) => mapAsset(asset));
  }

  async getSearchSuggestions(auth: AuthDto, dto: SearchSuggestionRequestDto) {
    const userIds = await this.getUserIdsToSearch(auth);
    const suggestions = await this.getSuggestions(userIds, dto);
    if (dto.includeNull) {
      suggestions.push(null);
    }
    return suggestions;
  }

  private getSuggestions(userIds: string[], dto: SearchSuggestionRequestDto): Promise<Array<string | null>> {
    switch (dto.type) {
      case SearchSuggestionType.COUNTRY: {
        return this.searchRepository.getCountries(userIds);
      }
      case SearchSuggestionType.STATE: {
        return this.searchRepository.getStates(userIds, dto);
      }
      case SearchSuggestionType.CITY: {
        return this.searchRepository.getCities(userIds, dto);
      }
      case SearchSuggestionType.CAMERA_MAKE: {
        return this.searchRepository.getCameraMakes(userIds, dto);
      }
      case SearchSuggestionType.CAMERA_MODEL: {
        return this.searchRepository.getCameraModels(userIds, dto);
      }
      case SearchSuggestionType.CAMERA_LENS_MODEL: {
        return this.searchRepository.getCameraLensModels(userIds, dto);
      }
      default: {
        return Promise.resolve([]);
      }
    }
  }

  private async getUserIdsToSearch(auth: AuthDto): Promise<string[]> {
    const partnerIds = await getMyPartnerIds({
      userId: auth.user.id,
      repository: this.partnerRepository,
      timelineEnabled: true,
    });
    return [auth.user.id, ...partnerIds];
  }

  private withExpandedCategoryFilters<T extends { category?: string; categoryL1?: string; categoryL2?: string }>(
    dto: T,
  ): T & { categoryNames?: string[]; categoryIncludeUnmapped?: boolean; categoryKnownNames?: string[] } {
    if (dto.category || (!dto.categoryL1 && !dto.categoryL2)) {
      return dto;
    }

    const categoryNames = getRawCategoriesByHierarchy({ categoryL1: dto.categoryL1, categoryL2: dto.categoryL2 }) ?? [];
    const categoryIncludeUnmapped = shouldIncludeUnmappedCategories({ categoryL1: dto.categoryL1, categoryL2: dto.categoryL2 });
    const categoryKnownNames = categoryIncludeUnmapped ? getKnownRawCategoryNames() : undefined;

    return { ...dto, categoryNames, categoryIncludeUnmapped, categoryKnownNames };
  }

  private mapResponse(assets: MapAsset[], nextPage: string | null, options: AssetMapOptions): SearchResponseDto {
    return {
      albums: { total: 0, count: 0, items: [], facets: [] },
      assets: {
        total: assets.length,
        count: assets.length,
        items: assets.map((asset) => mapAsset(asset, options)),
        facets: [],
        nextPage,
      },
    };
  }
}

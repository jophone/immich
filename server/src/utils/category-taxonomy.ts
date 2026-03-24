import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type CategoryLevel = {
  id: string;
  nameZh: string;
  nameEn: string;
};

type CategoryTaxonomyCache = {
  byL3: Map<string, CategoryHierarchy>;
  byL1: Map<string, Set<string>>;
  byL2: Map<string, Set<string>>;
  l2ToL1: Map<string, string>;
  knownRawCategories: Set<string>;
};

type ParsedCsvRow = {
  l1OriginalZh: string;
  l2OriginalZh: string;
  l3RawEn: string;
  l3RawZh?: string;
};

export type CategoryHierarchy = {
  rawCategoryName: string;
  rawCategoryNameZh?: string;
  l1: CategoryLevel;
  l2: CategoryLevel;
};

const OTHER_L1: CategoryLevel = { id: 'other', nameZh: '其他', nameEn: 'Other' };
const OTHER_L2: CategoryLevel = { id: 'other_misc', nameZh: '未分类', nameEn: 'Uncategorized' };

const L1_RENAME_MAP: Record<string, CategoryLevel> = {
  乐器与音响: { id: 'music_instruments', nameZh: '音乐与乐器', nameEn: 'Music & Instruments' },
  交通工具: { id: 'transportation', nameZh: '交通出行', nameEn: 'Transportation' },
  人物: { id: 'people', nameZh: '人像人物', nameEn: 'People' },
  '人/宠物': { id: 'people_pets', nameZh: '人/宠物', nameEn: 'People & Pets' },
  体育与娱乐: { id: 'sports_leisure', nameZh: '运动娱乐', nameEn: 'Sports & Leisure' },
  办公与学习用品: { id: 'office_study', nameZh: '办公学习', nameEn: 'Office & Study' },
  动物: { id: 'animals', nameZh: '动物', nameEn: 'Animals' },
  医疗与护理: { id: 'medical_care', nameZh: '医疗健康', nameEn: 'Medical & Care' },
  家居与家具: { id: 'home_living', nameZh: '家居生活', nameEn: 'Home Living' },
  容器与厨具: { id: 'kitchen_containers', nameZh: '厨房与容器', nameEn: 'Kitchen & Containers' },
  工具与工业: { id: 'tools_equipment', nameZh: '工具设备', nameEn: 'Tools & Equipment' },
  建筑与场所: { id: 'places_buildings', nameZh: '地点与建筑', nameEn: 'Places & Buildings' },
  服装与配饰: { id: 'apparel_accessories', nameZh: '服饰配件', nameEn: 'Apparel & Accessories' },
  植物与真菌: { id: 'plants_fungi', nameZh: '植物菌类', nameEn: 'Plants & Fungi' },
  武器与防护: { id: 'weapons_protection', nameZh: '武器防护', nameEn: 'Weapons & Protection' },
  电子设备: { id: 'electronics', nameZh: '数码电子', nameEn: 'Electronics' },
  美妆与个护: { id: 'beauty_personal_care', nameZh: '美妆个护', nameEn: 'Beauty & Personal Care' },
  自然景观: { id: 'nature_landscapes', nameZh: '自然风景', nameEn: 'Nature & Landscapes' },
  食品与饮品: { id: 'food_drinks', nameZh: '食品饮料', nameEn: 'Food & Drinks' },
};

const L2_RENAME_MAP: Record<string, CategoryLevel> = {
  '乐器与音响|乐器': { id: 'music_instruments_instruments', nameZh: '乐器', nameEn: 'Instruments' },
  '乐器与音响|乐器配件': {
    id: 'music_instruments_accessories',
    nameZh: '乐器配件',
    nameEn: 'Instrument Accessories',
  },

  '交通工具|交通部件': { id: 'transportation_vehicle_parts', nameZh: '车辆部件', nameEn: 'Vehicle Parts' },
  '交通工具|人力与畜力车辆': {
    id: 'transportation_human_animal_vehicles',
    nameZh: '人力畜力车',
    nameEn: 'Human-Powered & Animal-Drawn Vehicles',
  },
  '交通工具|工程与农用车辆': {
    id: 'transportation_utility_farm_vehicles',
    nameZh: '工程农用车',
    nameEn: 'Utility & Farm Vehicles',
  },
  '交通工具|汽车': { id: 'transportation_cars', nameZh: '汽车', nameEn: 'Cars' },
  '交通工具|自行车': { id: 'transportation_bicycles', nameZh: '自行车', nameEn: 'Bicycles' },
  '交通工具|船': { id: 'transportation_boats_ships', nameZh: '船艇', nameEn: 'Boats & Ships' },
  '交通工具|轨道车辆': { id: 'transportation_rail_vehicles', nameZh: '轨道交通', nameEn: 'Rail Vehicles' },
  '交通工具|飞机': { id: 'transportation_aircraft', nameZh: '飞机', nameEn: 'Aircraft' },
  '交通工具|飞行与降落装备': { id: 'transportation_flight_gear', nameZh: '飞行装备', nameEn: 'Flight Gear' },

  '人物|人物': { id: 'people_people', nameZh: '人物', nameEn: 'People' },

  '人/宠物|人物主体': { id: 'people_pets_people_subjects', nameZh: '人物主体', nameEn: 'People Subjects' },
  '人/宠物|宠物主体': { id: 'people_pets_pet_subjects', nameZh: '宠物主体', nameEn: 'Pet Subjects' },
  '人/宠物|人宠共现': {
    id: 'people_pets_people_pet_copresence',
    nameZh: '人宠共现',
    nameEn: 'People & Pets Co-occurrence',
  },

  '体育与娱乐|体育用品': { id: 'sports_leisure_sports_gear', nameZh: '运动器材', nameEn: 'Sports Gear' },
  '体育与娱乐|玩具与娱乐': {
    id: 'sports_leisure_toys_entertainment',
    nameZh: '玩具娱乐',
    nameEn: 'Toys & Entertainment',
  },

  '办公与学习用品|信息与媒体': { id: 'office_study_media_information', nameZh: '信息媒体', nameEn: 'Media & Information' },
  '办公与学习用品|学习与益智用品': {
    id: 'office_study_learning_puzzles',
    nameZh: '学习益智',
    nameEn: 'Learning & Puzzles',
  },
  '办公与学习用品|文具与办公用品': { id: 'office_study_office_supplies', nameZh: '文具办公', nameEn: 'Office Supplies' },

  '动物|两栖动物': { id: 'animals_amphibians', nameZh: '两栖类', nameEn: 'Amphibians' },
  '动物|兔': { id: 'animals_rabbits', nameZh: '兔类', nameEn: 'Rabbits' },
  '动物|其他哺乳动物': { id: 'animals_other_mammals', nameZh: '其他哺乳类', nameEn: 'Other Mammals' },
  '动物|啮齿动物': { id: 'animals_rodents', nameZh: '啮齿类', nameEn: 'Rodents' },
  '动物|大象': { id: 'animals_elephants', nameZh: '象类', nameEn: 'Elephants' },
  '动物|昆虫': { id: 'animals_insects', nameZh: '昆虫', nameEn: 'Insects' },
  '动物|海洋动物': { id: 'animals_marine_life', nameZh: '海洋生物', nameEn: 'Marine Life' },
  '动物|熊': { id: 'animals_bears', nameZh: '熊类', nameEn: 'Bears' },
  '动物|熊猫': { id: 'animals_pandas', nameZh: '熊猫', nameEn: 'Pandas' },
  '动物|爬行动物': { id: 'animals_reptiles', nameZh: '爬行动物', nameEn: 'Reptiles' },
  '动物|牛': { id: 'animals_cattle', nameZh: '牛类', nameEn: 'Cattle' },
  '动物|牛羊类有蹄动物': { id: 'animals_hoofed_mammals', nameZh: '有蹄动物', nameEn: 'Hoofed Mammals' },
  '动物|狐': { id: 'animals_foxes', nameZh: '狐类', nameEn: 'Foxes' },
  '动物|狗': { id: 'animals_dogs', nameZh: '犬类', nameEn: 'Dogs' },
  '动物|狮子': { id: 'animals_lions', nameZh: '狮子', nameEn: 'Lions' },
  '动物|狼': { id: 'animals_wolves', nameZh: '狼类', nameEn: 'Wolves' },
  '动物|猪': { id: 'animals_pigs', nameZh: '猪类', nameEn: 'Pigs' },
  '动物|猫': { id: 'animals_domestic_cats', nameZh: '家猫', nameEn: 'Domestic Cats' },
  '动物|猫科动物': { id: 'animals_wild_cats', nameZh: '野生猫科', nameEn: 'Wild Cats' },
  '动物|猴子': { id: 'animals_primates', nameZh: '灵长类', nameEn: 'Primates' },
  '动物|羊': { id: 'animals_sheep_goats', nameZh: '羊类', nameEn: 'Sheep & Goats' },
  '动物|老虎': { id: 'animals_tigers', nameZh: '老虎', nameEn: 'Tigers' },
  '动物|蛇类': { id: 'animals_snakes', nameZh: '蛇', nameEn: 'Snakes' },
  '动物|蛛形纲与多足类': {
    id: 'animals_spiders_similar_creatures',
    nameZh: '蛛类与多足',
    nameEn: 'Spiders & Similar Creatures',
  },
  '动物|蝴蝶与飞蛾': { id: 'animals_butterflies_moths', nameZh: '蝴蝶飞蛾', nameEn: 'Butterflies & Moths' },
  '动物|马': { id: 'animals_horses_zebras', nameZh: '马类', nameEn: 'Horses & Zebras' },
  '动物|鱼类与水生脊椎动物': {
    id: 'animals_fish_aquatic_vertebrates',
    nameZh: '鱼类与水生脊椎',
    nameEn: 'Fish & Aquatic Vertebrates',
  },
  '动物|鸟类': { id: 'animals_birds', nameZh: '鸟类', nameEn: 'Birds' },

  '医疗与护理|医疗与护理用品': {
    id: 'medical_care_items',
    nameZh: '医疗护理用品',
    nameEn: 'Medical Care Items',
  },

  '家居与家具|卫浴设施': { id: 'home_living_bathroom_fixtures', nameZh: '卫浴用品', nameEn: 'Bathroom Fixtures' },
  '家居与家具|家具与家居用品': {
    id: 'home_living_furniture_household_items',
    nameZh: '家具日用',
    nameEn: 'Furniture & Household Items',
  },
  '家居与家具|家电': { id: 'home_living_home_appliances', nameZh: '家用电器', nameEn: 'Home Appliances' },
  '家居与家具|家纺与材料': { id: 'home_living_home_textiles', nameZh: '家纺布料', nameEn: 'Home Textiles' },
  '家居与家具|灯具': { id: 'home_living_lighting', nameZh: '灯具', nameEn: 'Lighting' },

  '容器与厨具|厨房工具': { id: 'kitchen_containers_kitchen_tools', nameZh: '厨房工具', nameEn: 'Kitchen Tools' },
  '容器与厨具|容器与厨具': {
    id: 'kitchen_containers_general_containers',
    nameZh: '通用容器',
    nameEn: 'General Containers',
  },

  '工具与工业|五金零件': { id: 'tools_equipment_hardware_parts', nameZh: '五金件', nameEn: 'Hardware Parts' },
  '工具与工业|工具与工业设备': {
    id: 'tools_equipment_industrial_tools',
    nameZh: '工具设备',
    nameEn: 'Tools & Industrial Equipment',
  },

  '建筑与场所|公共设施': { id: 'places_buildings_street_fixtures', nameZh: '街道设施', nameEn: 'Street Fixtures' },
  '建筑与场所|土木与户外结构': {
    id: 'places_buildings_outdoor_structures',
    nameZh: '户外结构',
    nameEn: 'Outdoor Structures',
  },
  '建筑与场所|建筑与场所': {
    id: 'places_buildings_buildings_places',
    nameZh: '建筑地点',
    nameEn: 'Buildings & Places',
  },

  '服装与配饰|服装': { id: 'apparel_accessories_clothing', nameZh: '服装', nameEn: 'Clothing' },
  '服装与配饰|配饰': { id: 'apparel_accessories_accessories', nameZh: '配件', nameEn: 'Accessories' },
  '服装与配饰|鞋': { id: 'apparel_accessories_footwear', nameZh: '鞋类', nameEn: 'Footwear' },

  '植物与真菌|植物': { id: 'plants_fungi_plants', nameZh: '植物', nameEn: 'Plants' },
  '植物与真菌|真菌': { id: 'plants_fungi_fungi', nameZh: '菌类', nameEn: 'Fungi' },

  '武器与防护|武器': { id: 'weapons_protection_weapons', nameZh: '武器', nameEn: 'Weapons' },
  '武器与防护|防护装备': { id: 'weapons_protection_protective_gear', nameZh: '防护装备', nameEn: 'Protective Gear' },

  '电子设备|手机设备': {
    id: 'electronics_communication_devices',
    nameZh: '通信设备',
    nameEn: 'Communication Devices',
  },
  '电子设备|电子仪器与影音设备': {
    id: 'electronics_av_instruments',
    nameZh: '影音与电子仪器',
    nameEn: 'AV & Electronic Instruments',
  },
  '电子设备|电脑设备': { id: 'electronics_computer_devices', nameZh: '电脑设备', nameEn: 'Computer Devices' },

  '美妆与个护|美妆与个护': {
    id: 'beauty_personal_care_items',
    nameZh: '美妆个护用品',
    nameEn: 'Beauty & Personal Care Items',
  },

  '自然景观|自然景观': { id: 'nature_landscapes_scenery', nameZh: '自然风景', nameEn: 'Natural Scenery' },

  '食品与饮品|蔬果食材': {
    id: 'food_drinks_produce_ingredients',
    nameZh: '蔬果食材',
    nameEn: 'Produce & Ingredients',
  },
  '食品与饮品|食物': { id: 'food_drinks_prepared_food', nameZh: '熟食餐食', nameEn: 'Prepared Food' },
  '食品与饮品|饮品': { id: 'food_drinks_beverages', nameZh: '饮品', nameEn: 'Beverages' },
};

const TAXONOMY_FILE_PATH_CANDIDATES = [
  resolve(__dirname, '../../../docs/ImageNet_Taxonomy.csv'),
  resolve(process.cwd(), 'docs/ImageNet_Taxonomy.csv'),
  resolve(process.cwd(), '../docs/ImageNet_Taxonomy.csv'),
];

let taxonomyCache: CategoryTaxonomyCache | null = null;

const normalizeCategoryLabel = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replaceAll(/[_-]+/g, ' ')
    .replaceAll(/\s+/g, ' ');

const parseRawL3Label = (value: string): { l3RawEn: string; l3RawZh?: string } => {
  const trimmed = value.trim();
  const match = trimmed.match(/^(.+?)（(.+)）$/);

  if (!match) {
    return { l3RawEn: trimmed };
  }

  const [, l3RawEn, l3RawZh] = match;
  return {
    l3RawEn: l3RawEn.trim(),
    l3RawZh: l3RawZh.trim(),
  };
};

const resolveL1 = (l1OriginalZh: string): CategoryLevel => {
  return L1_RENAME_MAP[l1OriginalZh] ?? OTHER_L1;
};

const resolveL2 = (l1OriginalZh: string, l2OriginalZh: string): CategoryLevel => {
  return L2_RENAME_MAP[`${l1OriginalZh}|${l2OriginalZh}`] ?? OTHER_L2;
};

const getTaxonomyFilePath = (): string | undefined => {
  return TAXONOMY_FILE_PATH_CANDIDATES.find((path) => existsSync(path));
};

const parseRows = (csvContent: string): ParsedCsvRow[] => {
  const lines = csvContent.split(/\r?\n/);
  const rows: ParsedCsvRow[] = [];
  let currentL1 = '';
  let currentL2 = '';

  for (const rawLine of lines) {
    const line = rawLine.replace(/^\uFEFF/, '');

    if (!line || line.startsWith('一级类别,')) {
      continue;
    }

    const columns = line.split(',');
    if (columns.length < 4) {
      continue;
    }

    const l1 = columns[0]?.trim() || currentL1;
    const l2 = columns[1]?.trim() || currentL2;
    const l3 = columns[3]?.trim();

    if (!l1 || !l2 || !l3) {
      continue;
    }

    currentL1 = l1;
    currentL2 = l2;

    const labels = l3
      .split('，')
      .map((value) => value.trim())
      .filter(Boolean);

    for (const label of labels) {
      const { l3RawEn, l3RawZh } = parseRawL3Label(label);
      rows.push({ l1OriginalZh: l1, l2OriginalZh: l2, l3RawEn, l3RawZh });
    }
  }

  return rows;
};

const buildCache = (): CategoryTaxonomyCache => {
  const emptyCache: CategoryTaxonomyCache = {
    byL3: new Map(),
    byL1: new Map(),
    byL2: new Map(),
    l2ToL1: new Map([[OTHER_L2.id, OTHER_L1.id]]),
    knownRawCategories: new Set(),
  };

  const taxonomyPath = getTaxonomyFilePath();
  if (!taxonomyPath) {
    return emptyCache;
  }

  const content = readFileSync(taxonomyPath, 'utf8');
  const rows = parseRows(content);

  for (const row of rows) {
    const l1 = resolveL1(row.l1OriginalZh);
    const l2 = resolveL2(row.l1OriginalZh, row.l2OriginalZh);
    const rawCategoryName = row.l3RawEn;
    const hierarchy: CategoryHierarchy = {
      rawCategoryName,
      rawCategoryNameZh: row.l3RawZh,
      l1,
      l2,
    };

    emptyCache.byL3.set(normalizeCategoryLabel(rawCategoryName), hierarchy);
    emptyCache.knownRawCategories.add(rawCategoryName);

    const l1Names = emptyCache.byL1.get(l1.id) ?? new Set<string>();
    l1Names.add(rawCategoryName);
    emptyCache.byL1.set(l1.id, l1Names);

    const l2Names = emptyCache.byL2.get(l2.id) ?? new Set<string>();
    l2Names.add(rawCategoryName);
    emptyCache.byL2.set(l2.id, l2Names);

    emptyCache.l2ToL1.set(l2.id, l1.id);
  }

  return emptyCache;
};

const getCache = (): CategoryTaxonomyCache => {
  taxonomyCache ??= buildCache();
  return taxonomyCache;
};

export const getCategoryHierarchy = (rawCategoryName: string): CategoryHierarchy => {
  const normalized = normalizeCategoryLabel(rawCategoryName);
  const hierarchy = getCache().byL3.get(normalized);

  return (
    hierarchy ?? {
      rawCategoryName,
      l1: OTHER_L1,
      l2: OTHER_L2,
    }
  );
};

export const getRawCategoriesByHierarchy = (options: {
  categoryL1?: string;
  categoryL2?: string;
}): string[] | undefined => {
  const { categoryL1, categoryL2 } = options;
  if (!categoryL1 && !categoryL2) {
    return undefined;
  }

  const { byL1, byL2, l2ToL1 } = getCache();

  if (categoryL2) {
    const parentL1 = l2ToL1.get(categoryL2);
    if (categoryL1 && parentL1 !== categoryL1) {
      return [];
    }

    return [...(byL2.get(categoryL2) ?? [])];
  }

  return [...(byL1.get(categoryL1!) ?? [])];
};

export const getKnownRawCategoryNames = (): string[] => {
  return [...getCache().knownRawCategories];
};

export const shouldIncludeUnmappedCategories = (options: {
  categoryL1?: string;
  categoryL2?: string;
}): boolean => {
  const { categoryL1, categoryL2 } = options;

  if (categoryL2) {
    if (categoryL2 !== OTHER_L2.id) {
      return false;
    }

    return !categoryL1 || categoryL1 === OTHER_L1.id;
  }

  return categoryL1 === OTHER_L1.id;
};

export const isChineseLanguage = (language: string | null | undefined): boolean => {
  return language?.toLowerCase().startsWith('zh') ?? false;
};

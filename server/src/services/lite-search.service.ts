import { Injectable } from '@nestjs/common';
import { JOBS_ASSET_PAGINATION_SIZE } from 'src/constants';
import { OnJob } from 'src/decorators';
import { JobName, JobStatus, QueueName } from 'src/enum';
import { BaseService } from 'src/services/base.service';
import { JobItem, JobOf } from 'src/types';
import { getCategoryHierarchy } from 'src/utils/category-taxonomy';
import { isLiteSearchEnabled } from 'src/utils/misc';

@Injectable()
export class LiteSearchService extends BaseService {
  @OnJob({ name: JobName.LiteSearchQueueAll, queue: QueueName.LiteSearch })
  async handleQueueLiteSearch({ force }: JobOf<JobName.LiteSearchQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isLiteSearchEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    let queue: JobItem[] = [];
    const assets = this.assetJobRepository.streamForLiteSearchJob(force);
    for await (const asset of assets) {
      queue.push({ name: JobName.LiteSearch, data: { id: asset.id } });
      if (queue.length >= JOBS_ASSET_PAGINATION_SIZE) {
        await this.jobRepository.queueAll(queue);
        queue = [];
      }
    }

    await this.jobRepository.queueAll(queue);

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.LiteSearch, queue: QueueName.LiteSearch })
  async handleLiteSearch({ id }: JobOf<JobName.LiteSearch>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isLiteSearchEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    const categories = await this.categoryRepository.getByAssetId(id);
    if (categories.length === 0) {
      return JobStatus.Skipped;
    }

    const categoryString = this.buildCategoryString(categories);
    const embedding = await this.machineLearningRepository.encodeLiteText(
      categoryString,
      machineLearning.liteSearch,
    );

    await this.searchRepository.upsertLite(id, embedding);

    return JobStatus.Success;
  }

  private buildCategoryString(categories: { categoryName: string; confidence: number }[]): string {
    const parts: string[] = [];
    for (const { categoryName } of categories) {
      const hierarchy = getCategoryHierarchy(categoryName);
      // Include raw English name
      parts.push(categoryName);
      // Include Chinese name if available
      if (hierarchy.rawCategoryNameZh) {
        parts.push(hierarchy.rawCategoryNameZh);
      }
      // Include L2 and L1 labels for broader context
      parts.push(hierarchy.l2.nameEn, hierarchy.l2.nameZh);
      parts.push(hierarchy.l1.nameEn, hierarchy.l1.nameZh);
    }
    return [...new Set(parts)].join(' ');
  }
}

import { Injectable } from '@nestjs/common';
import { JOBS_ASSET_PAGINATION_SIZE } from 'src/constants';
import { OnJob } from 'src/decorators';
import { AuthDto } from 'src/dtos/auth.dto';
import { CategorySummaryResponseDto } from 'src/dtos/category.dto';
import { ClassificationDetectionConfig } from 'src/dtos/model-config.dto';
import { AssetVisibility, JobName, JobStatus, Permission, QueueName } from 'src/enum';
import { ObjectDetectionResult } from 'src/repositories/machine-learning.repository';
import { BaseService } from 'src/services/base.service';
import { JobItem, JobOf } from 'src/types';
import { getCategoryHierarchy } from 'src/utils/category-taxonomy';
import { isClassificationEnabled } from 'src/utils/misc';

// ---------------------------------------------------------------------------
// Detection → L3 tag mapping rules.
//
// To adapt for a custom detection model, update the class names below to match
// your model's output (as defined in detection_classes.py on the ML side).
// ---------------------------------------------------------------------------

/** Which detection className represents "person". */
const PERSON_CLASS = 'person';

/** Detection className → L3 pet category tag. */
const PET_CLASSES: Record<string, string> = {
  dog: 'pet_dog',
  cat: 'pet_cat',
  bird: 'pet_bird',
};

/** Person + specific pet → L3 co-occurrence tag. */
const COPRESENCE_RULES: Record<string, string> = {
  dog: 'person_with_dog',
  cat: 'person_with_cat',
};

@Injectable()
export class ClassificationService extends BaseService {
  @OnJob({ name: JobName.ClassificationQueueAll, queue: QueueName.Classification })
  async handleQueueClassification({ force }: JobOf<JobName.ClassificationQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isClassificationEnabled(machineLearning)) {
      this.logger.debug('Skipping ClassificationQueueAll: classification is disabled');
      return JobStatus.Skipped;
    }

    if (force) {
      await this.categoryRepository.deleteAll();
    }

    let queued = 0;
    let jobs: JobItem[] = [];
    const assets = this.assetJobRepository.streamForClassificationJob(force);

    for await (const asset of assets) {
      jobs.push({ name: JobName.Classification, data: { id: asset.id } });
      queued++;

      if (jobs.length >= JOBS_ASSET_PAGINATION_SIZE) {
        await this.jobRepository.queueAll(jobs);
        jobs = [];
      }
    }

    await this.jobRepository.queueAll(jobs);
    this.logger.debug(`Queued ${queued} assets for classification`);
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.Classification, queue: QueueName.Classification })
  async handleClassification({ id }: JobOf<JobName.Classification>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isClassificationEnabled(machineLearning)) {
      this.logger.debug(`Skipping classification for asset ${id}: classification is disabled`);
      return JobStatus.Skipped;
    }

    const asset = await this.assetJobRepository.getForClassification(id);
    if (!asset) {
      this.logger.debug(`Failed classification for asset ${id}: asset not found`);
      return JobStatus.Failed;
    }

    if (!asset.previewFile) {
      this.logger.debug(`Failed classification for asset ${id}: preview file not found`);
      return JobStatus.Failed;
    }

    if (asset.visibility === AssetVisibility.Hidden) {
      this.logger.debug(`Skipping classification for asset ${id}: asset is hidden`);
      return JobStatus.Skipped;
    }

    const { classification } = machineLearning;

    // ① Run classification (existing logic)
    const classificationResults = await this.machineLearningRepository.classifyImage(asset.previewFile, {
      modelName: classification.modelName,
      minScore: classification.minScore,
      maxResults: classification.maxResults,
      categories: classification.categories,
    });

    // ② Unconditionally run object detection (if enabled)
    let detectionCategories: { categoryName: string; confidence: number }[] = [];
    if (classification.detection?.enabled) {
      try {
        detectionCategories = await this.runDetectionAndPostProcess(asset.previewFile, classification.detection);
      } catch (error: unknown) {
        this.logger.warn(`Detection failed for asset ${id}, skipping: ${error}`);
      }
    }

    // ③ Merge classification + detection-derived tags
    const allResults = [...classificationResults, ...detectionCategories];
    const categories = allResults.map((r) => ({
      assetId: id,
      categoryName: r.categoryName,
      confidence: r.confidence,
    }));

    await this.categoryRepository.upsert(id, categories);
    await this.assetRepository.upsertJobStatus({ assetId: id, classifiedAt: new Date() });

    this.logger.debug(
      `Classified asset ${id} with ${classificationResults.length} categories` +
        (detectionCategories.length > 0 ? ` + ${detectionCategories.length} detection tags` : ''),
    );
    return JobStatus.Success;
  }

  async getAssetCategories(auth: AuthDto, assetId: string) {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [assetId] });
    return this.categoryRepository.getByAssetId(assetId);
  }

  async getCategorySummaries(auth: AuthDto) {
    const summaries = await this.categoryRepository.getDistinctCategories(auth.user.id);

    return summaries.map<CategorySummaryResponseDto>((summary) => {
      const hierarchy = getCategoryHierarchy(summary.categoryName);

      return {
        categoryName: summary.categoryName,
        categoryNameZh: hierarchy.rawCategoryNameZh,
        count: summary.count,
        categoryL1Id: hierarchy.l1.id,
        categoryL1NameZh: hierarchy.l1.nameZh,
        categoryL1NameEn: hierarchy.l1.nameEn,
        categoryL2Id: hierarchy.l2.id,
        categoryL2NameZh: hierarchy.l2.nameZh,
        categoryL2NameEn: hierarchy.l2.nameEn,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Private: detection post-processing
  // ---------------------------------------------------------------------------

  private async runDetectionAndPostProcess(
    previewFile: string,
    config: ClassificationDetectionConfig,
  ): Promise<{ categoryName: string; confidence: number }[]> {
    const detections = await this.machineLearningRepository.detectObjects(previewFile, {
      modelName: config.modelName,
      minScore: config.minScore,
    });

    if (detections.length === 0) {
      return [];
    }

    // Group detections by className
    const byClass = new Map<string, ObjectDetectionResult[]>();
    for (const d of detections) {
      const list = byClass.get(d.className) ?? [];
      list.push(d);
      byClass.set(d.className, list);
    }

    const results: { categoryName: string; confidence: number }[] = [];
    const persons = byClass.get(PERSON_CLASS) ?? [];

    // === People counting ===
    if (persons.length === 1) {
      results.push({ categoryName: 'single_person', confidence: persons[0].confidence });
    } else if (persons.length === 2) {
      results.push({ categoryName: 'two_people', confidence: avgConfidence(persons) });
    } else if (persons.length >= 3) {
      results.push({ categoryName: 'multiple_people', confidence: avgConfidence(persons) });
    }

    // === Pet identification (dynamic over PET_CLASSES) ===
    let anyPetDetected = false;
    let maxPetConf = 0;
    for (const [className, tagName] of Object.entries(PET_CLASSES)) {
      const items = byClass.get(className);
      if (items && items.length > 0) {
        const conf = maxConfidence(items);
        results.push({ categoryName: tagName, confidence: conf });
        anyPetDetected = true;
        maxPetConf = Math.max(maxPetConf, conf);
      }
    }

    // === People-pet co-occurrence (dynamic over COPRESENCE_RULES) ===
    if (persons.length > 0) {
      const personConf = maxConfidence(persons);
      for (const [className, tagName] of Object.entries(COPRESENCE_RULES)) {
        const items = byClass.get(className);
        if (items && items.length > 0) {
          results.push({
            categoryName: tagName,
            confidence: Math.min(personConf, maxConfidence(items)),
          });
        }
      }
      // Generic: person + any pet → person_with_pet
      if (anyPetDetected) {
        results.push({
          categoryName: 'person_with_pet',
          confidence: Math.min(personConf, maxPetConf),
        });
      }
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maxConfidence(items: { confidence: number }[]): number {
  return Math.max(...items.map((d) => d.confidence));
}

function avgConfidence(items: { confidence: number }[]): number {
  return items.reduce((sum, d) => sum + d.confidence, 0) / items.length;
}

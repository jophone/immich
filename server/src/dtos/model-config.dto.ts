import { ApiProperty } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';
import { ArrayMinSize, IsNotEmpty, IsNumber, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import { ValidateBoolean } from 'src/validation';

export class TaskConfig {
  @ValidateBoolean({ description: 'Whether the task is enabled' })
  enabled!: boolean;
}

export class ModelConfig extends TaskConfig {
  @ApiProperty({ description: 'Name of the model to use' })
  @IsString()
  @IsNotEmpty()
  modelName!: string;
}

export class CLIPConfig extends ModelConfig {}

export class DuplicateDetectionConfig extends TaskConfig {
  @IsNumber()
  @Min(0.001)
  @Max(0.1)
  @Type(() => Number)
  @ApiProperty({
    type: 'number',
    format: 'double',
    description: 'Maximum distance threshold for duplicate detection',
  })
  maxDistance!: number;
}

export class FacialRecognitionConfig extends ModelConfig {
  @IsNumber()
  @Min(0.1)
  @Max(1)
  @Type(() => Number)
  @ApiProperty({ type: 'number', format: 'double', description: 'Minimum confidence score for face detection' })
  minScore!: number;

  @IsNumber()
  @Min(0.1)
  @Max(2)
  @Type(() => Number)
  @ApiProperty({
    type: 'number',
    format: 'double',
    description: 'Maximum distance threshold for face recognition',
  })
  maxDistance!: number;

  @IsNumber()
  @Min(1)
  @Type(() => Number)
  @ApiProperty({ type: 'integer', description: 'Minimum number of faces required for recognition' })
  minFaces!: number;
}

export class OcrConfig extends ModelConfig {
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  @ApiProperty({ type: 'integer', description: 'Maximum resolution for OCR processing' })
  maxResolution!: number;

  @IsNumber()
  @Min(0.1)
  @Max(1)
  @Type(() => Number)
  @ApiProperty({ type: 'number', format: 'double', description: 'Minimum confidence score for text detection' })
  minDetectionScore!: number;

  @IsNumber()
  @Min(0.1)
  @Max(1)
  @Type(() => Number)
  @ApiProperty({
    type: 'number',
    format: 'double',
    description: 'Minimum confidence score for text recognition',
  })
  minRecognitionScore!: number;
}

export class ClassificationDetectionConfig {
  @ValidateBoolean({ description: 'Whether object detection is enabled for classification enrichment' })
  enabled!: boolean;

  @ApiProperty({ description: 'Name of the detection model to use' })
  @IsString()
  @IsNotEmpty()
  modelName!: string;

  @IsNumber()
  @Min(0)
  @Max(1)
  @Type(() => Number)
  @ApiProperty({ type: 'number', format: 'double', description: 'Minimum confidence score for object detection' })
  minScore!: number;
}

export class ClassificationConfig extends ModelConfig {
  @IsNumber()
  @Min(0)
  @Max(1)
  @Type(() => Number)
  @ApiProperty({ type: 'number', format: 'double', description: 'Minimum confidence score for classification' })
  minScore!: number;

  @IsNumber()
  @Min(1)
  @Type(() => Number)
  @ApiProperty({ type: 'integer', description: 'Maximum number of classification results' })
  maxResults!: number;

  @ArrayMinSize(1)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @ApiProperty({ type: 'array', items: { type: 'string' }, minItems: 1 })
  categories!: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ClassificationDetectionConfig)
  @ApiProperty({ type: ClassificationDetectionConfig, required: false })
  detection?: ClassificationDetectionConfig;
}

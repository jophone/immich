import { ApiProperty } from '@nestjs/swagger';

export class AssetCategoryResponseDto {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id!: string;

  @ApiProperty({ type: 'string', format: 'uuid' })
  assetId!: string;

  @ApiProperty({ type: 'string' })
  categoryName!: string;

  @ApiProperty({ type: 'number', format: 'double' })
  confidence!: number;
}

export class CategorySummaryResponseDto {
  @ApiProperty({ type: 'string' })
  categoryName!: string;

  @ApiProperty({ type: 'integer' })
  count!: number;

  @ApiProperty({ type: 'string' })
  categoryL1Id!: string;

  @ApiProperty({ type: 'string' })
  categoryL1NameZh!: string;

  @ApiProperty({ type: 'string' })
  categoryL1NameEn!: string;

  @ApiProperty({ type: 'string' })
  categoryL2Id!: string;

  @ApiProperty({ type: 'string' })
  categoryL2NameZh!: string;

  @ApiProperty({ type: 'string' })
  categoryL2NameEn!: string;

  @ApiProperty({ type: 'string', required: false })
  categoryNameZh?: string;
}

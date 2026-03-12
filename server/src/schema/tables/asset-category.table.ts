import { Column, ForeignKeyColumn, Generated, PrimaryGeneratedColumn, Table } from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table';

@Table('asset_categories')
export class AssetCategoryTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  assetId!: string;

  @Column({ type: 'text' })
  categoryName!: string;

  @Column({ type: 'real' })
  confidence!: number;
}

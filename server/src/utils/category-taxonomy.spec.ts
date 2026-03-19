import {
    getCategoryHierarchy,
    getKnownRawCategoryNames,
    getRawCategoriesByHierarchy,
    isChineseLanguage,
    shouldIncludeUnmappedCategories,
} from 'src/utils/category-taxonomy';
import { describe, expect, it } from 'vitest';

describe('getCategoryHierarchy', () => {
  it('should resolve known raw categories to L1/L2 hierarchy', () => {
    const hierarchy = getCategoryHierarchy('tabby cat');

    expect(hierarchy.rawCategoryName).toBe('tabby_cat');
    expect(hierarchy.rawCategoryNameZh).toBe('虎斑猫');
    expect(hierarchy.l1).toEqual({ id: 'animals', nameZh: '动物', nameEn: 'Animals' });
    expect(hierarchy.l2).toEqual({ id: 'animals_domestic_cats', nameZh: '家猫', nameEn: 'Domestic Cats' });
  });

  it('should fallback to other/uncategorized for unknown categories', () => {
    const hierarchy = getCategoryHierarchy('unknown-category-name');

    expect(hierarchy.l1).toEqual({ id: 'other', nameZh: '其他', nameEn: 'Other' });
    expect(hierarchy.l2).toEqual({ id: 'other_misc', nameZh: '未分类', nameEn: 'Uncategorized' });
  });
});

describe('getRawCategoriesByHierarchy', () => {
  it('should return undefined when no hierarchy filter is provided', () => {
    expect(getRawCategoriesByHierarchy({})).toBeUndefined();
  });

  it('should expand categoryL1 to raw categories', () => {
    const rawCategories = getRawCategoriesByHierarchy({ categoryL1: 'animals' });

    expect(rawCategories).toContain('tabby_cat');
    expect(rawCategories).toContain('tiger');
  });

  it('should expand categoryL2 to raw categories', () => {
    const rawCategories = getRawCategoriesByHierarchy({ categoryL2: 'animals_domestic_cats' });

    expect(rawCategories).toEqual(
      expect.arrayContaining(['tabby_cat', 'tiger_cat', 'Persian_cat', 'Siamese_cat', 'Egyptian_cat']),
    );
  });

  it('should return an empty array when categoryL1 and categoryL2 are incompatible', () => {
    expect(
      getRawCategoriesByHierarchy({
        categoryL1: 'animals',
        categoryL2: 'transportation_cars',
      }),
    ).toEqual([]);
  });
});

describe('isChineseLanguage', () => {
  it('should detect chinese language codes', () => {
    expect(isChineseLanguage('zh')).toBe(true);
    expect(isChineseLanguage('zh-CN')).toBe(true);
    expect(isChineseLanguage('ZH-tw')).toBe(true);
  });

  it('should return false for non-chinese language codes', () => {
    expect(isChineseLanguage('en')).toBe(false);
    expect(isChineseLanguage('fr')).toBe(false);
    expect(isChineseLanguage(undefined)).toBe(false);
    expect(isChineseLanguage(null)).toBe(false);
  });
});

describe('shouldIncludeUnmappedCategories', () => {
  it('should include unmapped categories for other L1', () => {
    expect(shouldIncludeUnmappedCategories({ categoryL1: 'other' })).toBe(true);
  });

  it('should include unmapped categories for other_misc L2', () => {
    expect(shouldIncludeUnmappedCategories({ categoryL2: 'other_misc' })).toBe(true);
    expect(shouldIncludeUnmappedCategories({ categoryL1: 'other', categoryL2: 'other_misc' })).toBe(true);
  });

  it('should not include unmapped categories for incompatible L1/L2 combinations', () => {
    expect(shouldIncludeUnmappedCategories({ categoryL1: 'animals', categoryL2: 'other_misc' })).toBe(false);
    expect(shouldIncludeUnmappedCategories({ categoryL2: 'animals_domestic_cats' })).toBe(false);
  });
});

describe('getKnownRawCategoryNames', () => {
  it('should expose known raw category names from taxonomy', () => {
    const knownCategories = getKnownRawCategoryNames();

    expect(knownCategories).toContain('tabby_cat');
    expect(knownCategories).toContain('tiger');
  });
});

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
    const hierarchy = getCategoryHierarchy('tabby');

    expect(hierarchy.rawCategoryName).toBe('tabby');
    expect(hierarchy.rawCategoryNameZh).toBe('虎斑猫');
    expect(hierarchy.l1).toEqual({ id: 'animals', nameZh: '动物', nameEn: 'Animals' });
    expect(hierarchy.l2).toEqual({ id: 'animals_domestic_cats', nameZh: '家猫', nameEn: 'Domestic Cats' });
  });

  it('should fallback to other/uncategorized for unknown categories', () => {
    const hierarchy = getCategoryHierarchy('unknown-category-name');

    expect(hierarchy.l1).toEqual({ id: 'other', nameZh: '其他', nameEn: 'Other' });
    expect(hierarchy.l2).toEqual({ id: 'other_misc', nameZh: '未分类', nameEn: 'Uncategorized' });
  });

  it('should resolve people_pets categories to the configured hierarchy', () => {
    const hierarchy = getCategoryHierarchy('single person');

    expect(hierarchy.rawCategoryName).toBe('single_person');
    expect(hierarchy.rawCategoryNameZh).toBe('单人');
    expect(hierarchy.l1).toEqual({ id: 'people_pets', nameZh: '人/宠物', nameEn: 'People & Pets' });
    expect(hierarchy.l2).toEqual({
      id: 'people_pets_people_subjects',
      nameZh: '人物主体',
      nameEn: 'People Subjects',
    });
  });
});

describe('getRawCategoriesByHierarchy', () => {
  it('should return undefined when no hierarchy filter is provided', () => {
    expect(getRawCategoriesByHierarchy({})).toBeUndefined();
  });

  it('should expand categoryL1 to raw categories', () => {
    const rawCategories = getRawCategoriesByHierarchy({ categoryL1: 'animals' });

    expect(rawCategories).toContain('tabby');
    expect(rawCategories).toContain('tiger');
  });

  it('should expand categoryL2 to raw categories', () => {
    const rawCategories = getRawCategoriesByHierarchy({ categoryL2: 'animals_domestic_cats' });

    expect(rawCategories).toEqual(expect.arrayContaining(['tabby', 'tiger_cat', 'Persian_cat', 'Siamese_cat', 'Egyptian_cat']));
  });

  it('should return an empty array when categoryL1 and categoryL2 are incompatible', () => {
    expect(
      getRawCategoriesByHierarchy({
        categoryL1: 'animals',
        categoryL2: 'transportation_cars',
      }),
    ).toEqual([]);
  });

  it('should expand people_pets hierarchy filters', () => {
    const rawCategories = getRawCategoriesByHierarchy({ categoryL1: 'people_pets' });

    expect(rawCategories).toEqual(expect.arrayContaining(['single_person', 'pet_dog', 'person_with_pet']));
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

    expect(knownCategories).toContain('tabby');
    expect(knownCategories).toContain('tiger');
    expect(knownCategories).toContain('person_with_pet');
  });
});

<script lang="ts">
  import Combobox, { asSelectedOption, type ComboBoxOption } from '$lib/components/shared-components/combobox.svelte';
  import { lang } from '$lib/stores/preferences.store';
  import { handlePromiseError } from '$lib/utils';
  import { getCategorySummaries, type CategorySummaryResponseDto } from '@immich/sdk';
  import { Text } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    category?: string;
    categoryL1?: string;
    categoryL2?: string;
  }

  let { category = $bindable(), categoryL1 = $bindable(), categoryL2 = $bindable() }: Props = $props();

  let summaries = $state<CategorySummaryResponseDto[]>([]);

  const isChineseLanguage = (language: string) => {
    return language.toLowerCase().startsWith('zh');
  };

  const getLocalizedLabel = (zh?: string, en?: string) => {
    const fallback = zh || en || '';
    return isChineseLanguage($lang) ? (zh || fallback) : (en || fallback);
  };

  const primaryCategoryText = $derived(isChineseLanguage($lang) ? '一级分类' : 'Primary Category');
  const secondaryCategoryText = $derived(isChineseLanguage($lang) ? '二级分类' : 'Secondary Category');

  let categoriesL1: ComboBoxOption[] = $derived.by(() => {
    const grouped = new Map<string, { labelZh?: string; labelEn?: string; count: number }>();

    for (const summary of summaries) {
      const key = summary.categoryL1Id ?? 'other';
      const existing = grouped.get(key) ?? {
        labelZh: summary.categoryL1NameZh,
        labelEn: summary.categoryL1NameEn,
        count: 0,
      };

      existing.count += summary.count;
      existing.labelZh ??= summary.categoryL1NameZh;
      existing.labelEn ??= summary.categoryL1NameEn;
      grouped.set(key, existing);
    }

    return [...grouped.entries()]
      .map(([value, entry]) => ({
        id: value,
        value,
        label: getLocalizedLabel(entry.labelZh, entry.labelEn) || value,
        count: entry.count,
      }))
      .sort((a, b) => b.count - a.count)
      .map(({ id, value, label }) => ({ id, value, label }));
  });

  let categoriesL2: ComboBoxOption[] = $derived.by(() => {
    const grouped = new Map<string, { labelZh?: string; labelEn?: string; count: number }>();

    for (const summary of summaries) {
      if (!categoryL1 || summary.categoryL1Id === categoryL1) {
        const key = summary.categoryL2Id ?? 'other_misc';
        const existing = grouped.get(key) ?? {
          labelZh: summary.categoryL2NameZh,
          labelEn: summary.categoryL2NameEn,
          count: 0,
        };

        existing.count += summary.count;
        existing.labelZh ??= summary.categoryL2NameZh;
        existing.labelEn ??= summary.categoryL2NameEn;
        grouped.set(key, existing);
      }
    }

    return [...grouped.entries()]
      .map(([value, entry]) => ({
        id: value,
        value,
        label: getLocalizedLabel(entry.labelZh, entry.labelEn) || value,
        count: entry.count,
      }))
      .sort((a, b) => b.count - a.count)
      .map(({ id, value, label }) => ({ id, value, label }));
  });

  async function updateCategories() {
    const results = await getCategorySummaries();
    summaries = results;

    if (category) {
      category = undefined;
    }

    if (categoryL1 && !categoriesL1.some((item) => item.value === categoryL1)) {
      categoryL1 = undefined;
    }

    if (categoryL2 && !categoriesL2.some((item) => item.value === categoryL2)) {
      categoryL2 = undefined;
    }
  }

  $effect(() => {
    if (category) {
      category = undefined;
    }

    if (!categoryL1 && categoryL2) {
      categoryL2 = undefined;
    }

    if (categoryL1 && !categoriesL1.some((item) => item.value === categoryL1)) {
      categoryL1 = undefined;
      categoryL2 = undefined;
    } else if (categoryL2 && !categoriesL2.some((item) => item.value === categoryL2)) {
      categoryL2 = undefined;
    }
  });

  onMount(() => {
    handlePromiseError(updateCategories());
  });
</script>

{#if categoriesL1.length > 0 || categoryL1 || categoryL2}
  <div id="category-selection">
    <Text fontWeight="medium">{$t('categories')}</Text>

    <div class="grid gap-3 md:grid-cols-2 mt-1">
      <Combobox
        label={primaryCategoryText}
        onSelect={(option) => {
          const nextValue = option?.value;
          if (categoryL1 !== nextValue) {
            categoryL1 = nextValue;
            categoryL2 = undefined;
          }
        }}
        options={categoriesL1}
        placeholder={primaryCategoryText}
        selectedOption={asSelectedOption(categoryL1)}
      />

      <Combobox
        label={secondaryCategoryText}
        disabled={!categoryL1}
        onSelect={(option) => (categoryL2 = option?.value)}
        options={categoriesL2}
        placeholder={secondaryCategoryText}
        selectedOption={asSelectedOption(categoryL2)}
      />
    </div>
  </div>
{/if}

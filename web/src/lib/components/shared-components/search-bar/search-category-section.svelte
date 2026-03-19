<script lang="ts">
  import Combobox, { asSelectedOption, type ComboBoxOption } from '$lib/components/shared-components/combobox.svelte';
  import { handlePromiseError } from '$lib/utils';
  import { getCategorySummaries } from '@immich/sdk';
  import { Text } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    category?: string;
  }

  let { category = $bindable() }: Props = $props();

  let categories: ComboBoxOption[] = $state([]);

  async function updateCategories() {
    const results = await getCategorySummaries();
    categories = results.map((result) => ({
      id: result.categoryName,
      label: result.categoryName,
      value: result.categoryName,
    }));

    if (category && !categories.some((item) => item.value === category)) {
      category = undefined;
    }
  }

  onMount(() => {
    handlePromiseError(updateCategories());
  });
</script>

{#if categories.length > 0 || category}
  <div id="category-selection">
    <Text fontWeight="medium">{$t('categories')}</Text>

    <div class="w-full mt-1">
      <Combobox
        label={$t('categories')}
        onSelect={(option) => (category = option?.value)}
        options={categories}
        placeholder={$t('categories')}
        selectedOption={asSelectedOption(category)}
      />
    </div>
  </div>
{/if}

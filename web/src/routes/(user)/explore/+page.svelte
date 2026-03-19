<script lang="ts">
  import ImageThumbnail from '$lib/components/assets/thumbnail/image-thumbnail.svelte';
  import UserPageLayout from '$lib/components/layouts/user-page-layout.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import EmptyPlaceholder from '$lib/components/shared-components/empty-placeholder.svelte';
  import SingleGridRow from '$lib/components/shared-components/single-grid-row.svelte';
  import { Route } from '$lib/route';
  import { lang } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl, getPeopleThumbnailUrl } from '$lib/utils';
  import { AssetMediaSize, type SearchExploreItem, type SearchExploreResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiHeart } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  const getFieldItems = (items: SearchExploreResponseDto[], field: string) => {
    const targetField = items.find((item) => item.fieldName === field);
    return targetField?.items || [];
  };

  const isChineseLanguage = (language: string) => {
    return language.toLowerCase().startsWith('zh');
  };

  const getCategoryLabel = (item: SearchExploreItem) => {
    return isChineseLanguage($lang) ? (item.labelZh ?? item.labelEn ?? item.value) : (item.labelEn ?? item.labelZh ?? item.value);
  };

  const primaryCategoryText = $derived(isChineseLanguage($lang) ? '一级分类' : 'Primary Category');
  const secondaryCategoryText = $derived(isChineseLanguage($lang) ? '二级分类' : 'Secondary Category');

  let places = $derived(getFieldItems(data.items, 'exifInfo.city'));
  let categoryL1Items = $derived(getFieldItems(data.items, 'categoryL1'));
  let categoryL2Items = $derived(getFieldItems(data.items, 'categoryL2'));
  let selectedCategoryL1 = $state<string | null>(null);
  let categoryL2ForSelected = $derived(
    categoryL2Items.filter((item) => item.parentValue && item.parentValue === selectedCategoryL1),
  );
  let people = $state(data.response.people);

  let hasPeople = $derived(data.response.total > 0);

  $effect(() => {
    if (categoryL1Items.length === 0) {
      selectedCategoryL1 = null;
      return;
    }

    if (!selectedCategoryL1 || !categoryL1Items.some((item) => item.value === selectedCategoryL1)) {
      selectedCategoryL1 = categoryL1Items[0].value;
    }
  });

  const onPersonThumbnailReady = ({ id }: { id: string }) => {
    for (const person of people) {
      if (person.id === id) {
        person.updatedAt = new Date().toISOString();
      }
    }
  };
</script>

<OnEvents {onPersonThumbnailReady} />

<UserPageLayout title={data.meta.title}>
  {#if hasPeople}
    <div class="mb-6 mt-2">
      <div class="flex justify-between">
        <p class="mb-4 font-medium dark:text-immich-dark-fg">{$t('people')}</p>
        <a
          href={Route.people()}
          class="pe-4 text-sm font-medium hover:text-immich-primary dark:text-immich-dark-fg dark:hover:text-immich-dark-primary"
          draggable="false">{$t('view_all')}</a
        >
      </div>
      <SingleGridRow class="grid grid-flow-col md:grid-auto-fill-28 grid-auto-fill-20 gap-x-4">
        {#snippet children({ itemCount })}
          {#each people.slice(0, itemCount) as person (person.id)}
            <a href={Route.viewPerson(person)} class="text-center relative">
              <ImageThumbnail
                circle
                shadow
                url={getPeopleThumbnailUrl(person)}
                altText={person.name}
                widthStyle="100%"
              />
              {#if person.isFavorite}
                <div class="absolute top-2 start-2">
                  <Icon icon={mdiHeart} size="24" class="text-white" />
                </div>
              {/if}
              <p class="mt-2 text-ellipsis text-sm font-medium dark:text-white">{person.name}</p>
            </a>
          {/each}
        {/snippet}
      </SingleGridRow>
    </div>
  {/if}

  {#if places.length > 0}
    <div class="mb-6 mt-2">
      <div class="flex justify-between">
        <p class="mb-4 font-medium dark:text-immich-dark-fg">{$t('places')}</p>
        <a
          href={Route.places()}
          class="pe-4 text-sm font-medium hover:text-immich-primary dark:text-immich-dark-fg dark:hover:text-immich-dark-primary"
          draggable="false">{$t('view_all')}</a
        >
      </div>
      <SingleGridRow class="grid grid-flow-col md:grid-auto-fill-36 grid-auto-fill-28 gap-x-4">
        {#snippet children({ itemCount })}
          {#each places.slice(0, itemCount) as item (item.data.id)}
            <a class="relative" href={Route.search({ city: item.value })} draggable="false">
              <div class="flex justify-center overflow-hidden rounded-xl brightness-75 filter">
                <img
                  src={getAssetMediaUrl({ id: item.data.id, size: AssetMediaSize.Thumbnail })}
                  alt={item.value}
                  class="object-cover aspect-square w-full"
                />
              </div>
              <span
                class="absolute bottom-2 w-full text-ellipsis px-1 text-center text-sm font-medium capitalize text-white backdrop-blur-[1px] hover:cursor-pointer"
              >
                {item.value}
              </span>
            </a>
          {/each}
        {/snippet}
      </SingleGridRow>
    </div>
  {/if}

  {#if categoryL1Items.length > 0}
    <div class="mb-6 mt-2">
      <div class="flex justify-between">
        <p class="mb-4 font-medium dark:text-immich-dark-fg">{$t('categories')}</p>
      </div>

      <p class="mb-3 text-sm font-medium dark:text-immich-dark-fg/80">{primaryCategoryText}</p>
      <div class="grid md:grid-auto-fill-36 grid-auto-fill-28 gap-x-4 gap-y-4 mb-5">
        {#each categoryL1Items as item (item.value)}
          <button
            class="relative text-left rounded-xl overflow-hidden border border-transparent transition hover:border-white/50 {selectedCategoryL1 ===
            item.value
              ? 'ring-2 ring-immich-primary dark:ring-immich-dark-primary'
              : ''}"
            type="button"
            draggable="false"
            onclick={() => (selectedCategoryL1 = item.value)}
          >
            <div class="flex justify-center overflow-hidden rounded-xl brightness-75 filter">
              <img
                src={getAssetMediaUrl({ id: item.data.id, size: AssetMediaSize.Thumbnail })}
                alt={getCategoryLabel(item)}
                class="object-cover aspect-square w-full"
              />
            </div>
            <span
              class="absolute bottom-2 w-full text-ellipsis px-1 text-center text-sm font-medium capitalize text-white backdrop-blur-[1px] hover:cursor-pointer"
            >
              {getCategoryLabel(item)}
            </span>
          </button>
        {/each}
      </div>

      {#if categoryL2ForSelected.length > 0}
        <p class="mb-3 text-sm font-medium dark:text-immich-dark-fg/80">{secondaryCategoryText}</p>
        <div class="grid md:grid-auto-fill-36 grid-auto-fill-28 gap-x-4 gap-y-4">
          {#each categoryL2ForSelected as item (item.value)}
            <a
              class="relative"
              href={Route.search({
                categoryL1: selectedCategoryL1 ?? undefined,
                categoryL2: item.value,
              })}
              draggable="false"
            >
              <div class="flex justify-center overflow-hidden rounded-xl brightness-75 filter">
                <img
                  src={getAssetMediaUrl({ id: item.data.id, size: AssetMediaSize.Thumbnail })}
                  alt={getCategoryLabel(item)}
                  class="object-cover aspect-square w-full"
                />
              </div>
              <span
                class="absolute bottom-2 w-full text-ellipsis px-1 text-center text-sm font-medium capitalize text-white backdrop-blur-[1px] hover:cursor-pointer"
              >
                {getCategoryLabel(item)}
              </span>
            </a>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if !hasPeople && places.length === 0 && categoryL1Items.length === 0}
    <EmptyPlaceholder text={$t('no_explore_results_message')} class="mt-10 mx-auto" />
  {/if}
</UserPageLayout>

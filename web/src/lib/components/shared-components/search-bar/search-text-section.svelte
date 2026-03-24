<script lang="ts">
  import RadioButton from '$lib/elements/RadioButton.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Field, Input, Text } from '@immich/ui';
  import { t } from 'svelte-i18n';

  interface Props {
    query: string | undefined;
    queryType?: 'smart' | 'lite' | 'metadata' | 'description' | 'ocr';
  }

  let { query = $bindable(), queryType = $bindable('smart') }: Props = $props();
</script>

<section>
  <fieldset>
    <Text class="mb-2" fontWeight="medium">{$t('search_type')}</Text>
    <div class="flex flex-wrap gap-x-5 gap-y-2 my-2">
      {#if featureFlagsManager.value.smartSearch}
        <RadioButton name="query-type" id="context-radio" label={$t('context')} bind:group={queryType} value="smart" />
      {/if}
      {#if featureFlagsManager.value.liteSearch}
        <RadioButton
          name="query-type"
          id="lite-search-radio"
          label={$t('lite_search')}
          bind:group={queryType}
          value="lite"
        />
      {/if}
      <RadioButton
        name="query-type"
        id="file-name-radio"
        label={$t('file_name_or_extension')}
        bind:group={queryType}
        value="metadata"
      />
      <RadioButton
        name="query-type"
        id="description-radio"
        label={$t('description')}
        bind:group={queryType}
        value="description"
      />
      {#if featureFlagsManager.value.ocr}
        <RadioButton name="query-type" id="ocr-radio" label={$t('ocr')} bind:group={queryType} value="ocr" />
      {/if}
    </div>
  </fieldset>

  {#if queryType === 'smart'}
    <Field label={$t('search_by_context')}>
      <Input type="text" placeholder={$t('sunrise_on_the_beach')} bind:value={query} />
    </Field>
  {:else if queryType === 'lite'}
    <Field label={$t('search_by_lite')}>
      <Input type="text" placeholder={$t('lite_search_placeholder')} bind:value={query} />
    </Field>
  {:else if queryType === 'metadata'}
    <Field label={$t('search_by_filename')}>
      <Input type="text" placeholder={$t('search_by_filename_example')} bind:value={query} />
    </Field>
  {:else if queryType === 'description'}
    <Field label={$t('search_by_description')}>
      <Input type="text" placeholder={$t('search_by_description_example')} bind:value={query} />
    </Field>
  {:else if queryType === 'ocr'}
    <Field label={$t('search_by_ocr')}>
      <Input type="text" placeholder={$t('search_by_ocr_example')} bind:value={query} />
    </Field>
  {/if}
</section>

const CURRENT_TERMS_VERSION = '1';
const CURRENT_AI_DATA_PROCESSING_VERSION = '1';

export function currentConsentVersions(hasConsentedToAiDataProcessing: boolean): {
  termsVersion: string;
  aiDataProcessingVersion: string | null;
} {
  return {
    termsVersion: CURRENT_TERMS_VERSION,
    aiDataProcessingVersion: hasConsentedToAiDataProcessing
      ? CURRENT_AI_DATA_PROCESSING_VERSION
      : null,
  };
}

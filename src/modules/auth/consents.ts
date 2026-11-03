import { ConsentType } from '../../generated/prisma/client.js';

export interface ConsentVersions {
  termsVersion: string;
  aiDataProcessingVersion: string | null;
}

export function buildConsentRows(
  { termsVersion, aiDataProcessingVersion }: ConsentVersions,
  grantedAt: Date,
): { type: ConsentType; version: string; grantedAt: Date }[] {
  return [
    { type: ConsentType.TERMS_OF_USE, version: termsVersion, grantedAt },
    { type: ConsentType.PRIVACY_POLICY, version: termsVersion, grantedAt },
    ...(aiDataProcessingVersion
      ? [{ type: ConsentType.AI_DATA_PROCESSING, version: aiDataProcessingVersion, grantedAt }]
      : []),
  ];
}

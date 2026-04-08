// TaskLeaders — Job ID Utilities
//
// Internal DB stores full job IDs: VAN-PLM-00001
// All public display (messages, UI, templates) uses: PLM-00001
//
// Locked rule: never expose the city prefix in public-facing copy.

/**
 * Strips the city prefix from an internal job ID for public display.
 * VAN-PLM-00001 → PLM-00001
 * PLM-00001     → PLM-00001 (already public format)
 */
export function toPublicJobId(jobId: string): string {
  const parts = jobId.split("-");
  if (parts.length === 3) {
    // Internal format: CITY-CAT-NNNNN
    return `${parts[1]}-${parts[2]}`;
  }
  // Already public format: CAT-NNNNN
  return jobId;
}

/**
 * Formats the standard job header used in all automated milestone messages.
 * Format: [Job #PLM-00001 | 123 Main St]
 *
 * @param jobId   Internal or public job ID (city prefix stripped automatically)
 * @param address The job address string
 */
export function jobHeader(jobId: string, address: string): string {
  return `[Job #${toPublicJobId(jobId)} | ${address}]`;
}

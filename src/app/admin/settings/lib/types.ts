/**
 * Component: Admin Settings - Shared Types
 * Documentation: documentation/settings-pages.md
 */

/**
 * Main settings object structure
 */
export interface Settings {
  backendMode: 'plex' | 'audiobookshelf';
  hasLocalUsers: boolean;
  hasLocalAdmins: boolean;
  audibleRegion: string;
  plex: PlexSettings;
  audiobookshelf: AudiobookshelfSettings;
  oidc: OIDCSettings;
  registration: RegistrationSettings;
  prowlarr: ProwlarrSettings;
  indexerOptions: IndexerOptionsSettings;
  automation: AutomationSettings;
  downloadClient: DownloadClientSettings;
  paths: PathsSettings;
  ebook: EbookSettings;
}

/**
 * Plex library configuration
 */
export interface PlexSettings {
  url: string;
  token: string;
  libraryId: string;
  triggerScanAfterImport: boolean;
}

/**
 * Audiobookshelf library configuration
 */
export interface AudiobookshelfSettings {
  serverUrl: string;
  apiToken: string;
  libraryId: string;
  triggerScanAfterImport: boolean;
}

/**
 * OIDC authentication configuration
 */
export interface OIDCSettings {
  enabled: boolean;
  providerName: string;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  accessControlMethod: string;
  accessGroupClaim: string;
  accessGroupValue: string;
  allowedEmails: string;
  allowedUsernames: string;
  adminClaimEnabled: boolean;
  adminClaimName: string;
  adminClaimValue: string;
}

/**
 * Manual registration configuration
 */
export interface RegistrationSettings {
  enabled: boolean;
  requireAdminApproval: boolean;
}

/**
 * Prowlarr indexer configuration
 */
export interface ProwlarrSettings {
  url: string;
  apiKey: string;
}

/**
 * Indexer-wide behavioral options (not tied to a specific indexer connection).
 * Persisted via `/api/admin/settings/indexer-options`.
 */
export interface IndexerOptionsSettings {
  /**
   * When true, automatic indexer searches skip books whose release date is
   * in the future. Default ON. Manual searches are unaffected.
   * Backing config key: `indexer.skip_unreleased`.
   */
  skipUnreleased: boolean;
  /**
   * Minimum ranking score (0-100) for an indexer result to be considered
   * for auto-grab. Default 25 (lowered from the original 50). ABB-style
   * pirate releases routinely score 25-40 due to low bitrate, missing tags,
   * and unconventional naming — raising this back to 50+ once you have
   * higher-quality indexers configured (MAM, etc.).
   * Backing config key: `indexer.min_quality_score`.
   */
  minQualityScore: number;
}

/**
 * Automation behavioral options (background lifecycle processors).
 * Persisted via `/api/admin/settings/automation`.
 */
export interface AutomationSettings {
  /**
   * Days a download can stay in `downloading` status before
   * detect-stalled-downloads auto-swaps the release. Clamped 1..365.
   * Backing config key: `automation.stall_timeout_days`.
   */
  stallTimeoutDays: number;
  /**
   * Stalled downloads at or above this progress percent are NOT swapped —
   * gives near-complete torrents more grace. Clamped 0..100, default 50.
   * Backing config key: `automation.stall_swap_max_progress`.
   */
  stallSwapMaxProgress: number;
  /**
   * Independent stall failures of the same release before it gets promoted to
   * a cross-request global block. Clamped 1..100, default 3.
   * Backing config key: `automation.global_block_threshold`.
   */
  globalBlockThreshold: number;
}

/**
 * Download client (qBittorrent) configuration
 */
export interface DownloadClientSettings {
  type: string;
  url: string;
  username: string;
  password: string;
  disableSSLVerify: boolean;
  remotePathMappingEnabled: boolean;
  remotePath: string;
  localPath: string;
}

/**
 * File paths and processing configuration
 */
export interface PathsSettings {
  downloadDir: string;
  mediaDir: string;
  audiobookPathTemplate?: string;
  ebookPathTemplate?: string;
  metadataTaggingEnabled: boolean;
  plexFormatCoercionEnabled: boolean;
  chapterMergingEnabled: boolean;
  fileRenameEnabled: boolean;
  fileRenameTemplate?: string;
  fileChmod?: string;
  dirChmod?: string;
}

/**
 * E-book sidecar configuration
 * Supports two sources: Anna's Archive (direct HTTP) and Indexer Search (Prowlarr)
 */
export interface EbookSettings {
  // Source toggles
  annasArchiveEnabled: boolean;
  indexerSearchEnabled: boolean;
  // Anna's Archive specific settings
  baseUrl: string;
  flaresolverrUrl: string;
  // General settings (shared across sources)
  preferredFormat: string;
  autoGrabEnabled: boolean;
  // Kindle compatibility
  kindleFixEnabled: boolean;
}

/**
 * Plex library item
 */
export interface PlexLibrary {
  id: string;
  title: string;
  type: string;
}

/**
 * Audiobookshelf library item
 */
export interface ABSLibrary {
  id: string;
  name: string;
  type: string;
  itemCount: number;
}

/**
 * Prowlarr indexer configuration
 */
export interface IndexerConfig {
  id: number;
  name: string;
  protocol: string;
  privacy: string;
  enabled: boolean;
  priority: number;
  seedingTimeMinutes?: number; // Torrents only
  ratioLimit?: number; // Torrents only (0 = no ratio requirement)
  removeAfterProcessing?: boolean; // Usenet only
  rssEnabled: boolean;
  audiobookCategories?: number[]; // Category IDs for audiobook searches (default: [3030])
  ebookCategories?: number[]; // Category IDs for ebook searches (default: [7020])
  supportsRss?: boolean;
}

/**
 * Saved indexer configuration (subset for UI)
 */
export interface SavedIndexerConfig {
  id: number;
  name: string;
  protocol: string;
  priority: number;
  seedingTimeMinutes?: number; // Torrents only
  ratioLimit?: number; // Torrents only (0 = no ratio requirement)
  removeAfterProcessing?: boolean; // Usenet only
  rssEnabled: boolean;
  audiobookCategories: number[]; // Category IDs for audiobook searches (default: [3030])
  ebookCategories: number[]; // Category IDs for ebook searches (default: [7020])
}

/**
 * Pending user awaiting approval
 */
export interface PendingUser {
  id: string;
  plexUsername: string;
  plexEmail: string | null;
  authProvider: string | null;
  createdAt: string;
}

/**
 * Validation state for all settings sections
 */
export interface ValidationState {
  plex?: boolean;
  audiobookshelf?: boolean;
  oidc?: boolean;
  registration?: boolean;
  prowlarr?: boolean;
  download?: boolean;
  paths?: boolean;
}

/**
 * Test result for connection tests
 */
export interface TestResult {
  success: boolean;
  message: string;
  responseTime?: number;
  templateValidation?: {
    isValid: boolean;
    error?: string;
    previewPaths?: string[];
  };
}

/**
 * Message/notification display
 */
export interface Message {
  type: 'success' | 'error';
  text: string;
}

/**
 * BookDate AI provider configuration
 */
export interface BookDateConfig {
  provider: string;
  apiKey?: string;
  model: string;
  baseUrl?: string;
  isEnabled: boolean;
  isVerified: boolean;
}

/**
 * BookDate AI model option
 */
export interface BookDateModel {
  id: string;
  name: string;
}

/**
 * Tab identifier type
 */
export type SettingsTab = 'library' | 'auth' | 'prowlarr' | 'download' | 'paths' | 'ebook' | 'bookdate' | 'notifications' | 'api';

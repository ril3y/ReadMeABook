/**
 * Component: Indexers Settings Tab
 * Documentation: documentation/settings-pages.md
 */

'use client';

import React, { useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Input } from '@/components/ui/Input';
import { IndexerManagement } from '@/components/admin/indexers/IndexerManagement';
import { FlagConfigRow } from '@/components/admin/FlagConfigRow';
import { IndexerFlagConfig } from '@/lib/utils/ranking-algorithm';
import { useIndexersSettings } from './useIndexersSettings';
import type { Settings, SavedIndexerConfig } from '../../lib/types';

interface IndexersTabProps {
  settings: Settings;
  originalSettings: Settings | null;
  indexers: SavedIndexerConfig[];
  flagConfigs: IndexerFlagConfig[];
  onChange: (settings: Settings) => void;
  onIndexersChange: (indexers: SavedIndexerConfig[]) => void;
  onFlagConfigsChange: (configs: IndexerFlagConfig[]) => void;
  onValidationChange: (isValid: boolean) => void;
  onRefreshIndexers?: () => Promise<void>;
}

export function IndexersTab({
  settings,
  originalSettings,
  indexers,
  flagConfigs,
  onChange,
  onIndexersChange,
  onFlagConfigsChange,
  onValidationChange,
  onRefreshIndexers,
}: IndexersTabProps) {
  const {
    testing,
    testResult,
    testConnection,
    showConnectionChangeConfirm,
    confirmConnectionChange,
    cancelConnectionChange,
    configuredIndexersCount,
  } = useIndexersSettings({
    prowlarrUrl: settings.prowlarr.url,
    prowlarrApiKey: settings.prowlarr.apiKey,
    originalProwlarrUrl: originalSettings?.prowlarr.url ?? '',
    originalProwlarrApiKey: originalSettings?.prowlarr.apiKey ?? '',
    configuredIndexersCount: indexers.length,
    onValidationChange,
    onRefreshIndexers,
    onClearIndexers: () => onIndexersChange([]),
  });

  // Auto-load indexers when component mounts if prowlarr is configured
  useEffect(() => {
    if (settings.prowlarr.url && settings.prowlarr.apiKey && onRefreshIndexers) {
      onRefreshIndexers();
    }
    // Only run on mount, not when settings change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Indexer Configuration
        </h2>
        <p className="text-gray-600 dark:text-gray-400 mb-6">
          Configure your Prowlarr connection and manage which indexers to use with priority and seeding time.
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Prowlarr Server URL
        </label>
        <Input
          type="url"
          value={settings.prowlarr.url}
          onChange={(e) => {
            onChange({
              ...settings,
              prowlarr: { ...settings.prowlarr, url: e.target.value },
            });
            onValidationChange(false);
          }}
          placeholder="http://localhost:9696"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Prowlarr API Key
        </label>
        <Input
          type="password"
          value={settings.prowlarr.apiKey}
          onChange={(e) => {
            onChange({
              ...settings,
              prowlarr: { ...settings.prowlarr, apiKey: e.target.value },
            });
            onValidationChange(false);
          }}
          placeholder="Enter API key"
        />
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Found in Prowlarr Settings &rarr; General &rarr; Security &rarr; API Key
        </p>
      </div>

      <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
        <Button
          onClick={testConnection}
          loading={testing}
          disabled={!settings.prowlarr.url || !settings.prowlarr.apiKey}
          variant="outline"
          className="w-full"
        >
          Test Connection
        </Button>
        {testResult && (
          <div className={`mt-3 p-3 rounded-lg text-sm ${
            testResult.success
              ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-800 dark:text-green-200'
              : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-200'
          }`}>
            {testResult.message}
          </div>
        )}
      </div>

      <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
        <div className="mb-4">
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
            Auto-Search Behavior
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Control how ReadMeABook performs automatic background searches across your indexers.
          </p>
        </div>

        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <div className="flex items-start gap-4">
            <input
              type="checkbox"
              id="indexer-skip-unreleased"
              checked={settings.indexerOptions.skipUnreleased}
              onChange={(e) =>
                onChange({
                  ...settings,
                  indexerOptions: {
                    ...settings.indexerOptions,
                    skipUnreleased: e.target.checked,
                  },
                })
              }
              className="mt-1 h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <div className="flex-1">
              <label
                htmlFor="indexer-skip-unreleased"
                className="block text-sm font-medium text-gray-900 dark:text-gray-100 cursor-pointer"
              >
                Skip unreleased books in automatic searches
              </label>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                When ON, ReadMeABook will not search indexers for books whose release date is in the future. These requests will automatically begin searching once the book is released. Manual searches are not affected.
              </p>
            </div>
          </div>
        </div>

        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700 mt-3">
          <div className="flex items-start gap-4">
            <div className="flex-1">
              <label
                htmlFor="stall-timeout-days"
                className="block text-sm font-medium text-gray-900 dark:text-gray-100"
              >
                Auto-swap stalled downloads after
              </label>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 mb-3">
                Days a download can stay in <code className="text-xs">downloading</code> status before the release is auto-blocked and a new search is queued. Hourly background pass; up to 50 stalls handled per run. Range 1&ndash;365 days.
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  id="stall-timeout-days"
                  min={1}
                  max={365}
                  step={1}
                  value={settings.automation.stallTimeoutDays}
                  onChange={(e) => {
                    const raw = Number.parseInt(e.target.value, 10);
                    const next = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 365) : 7;
                    onChange({
                      ...settings,
                      automation: {
                        ...settings.automation,
                        stallTimeoutDays: next,
                      },
                    });
                  }}
                  className="w-24 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-600 dark:text-gray-400">days</span>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700 mt-3">
          <div className="flex items-start gap-4">
            <div className="flex-1">
              <label
                htmlFor="stall-swap-max-progress"
                className="block text-sm font-medium text-gray-900 dark:text-gray-100"
              >
                Only swap when progress is below
              </label>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 mb-3">
                Stalled torrents at or above this percent are <strong>not</strong> swapped &mdash; gives near-complete downloads more grace before killing them. Lower = more conservative. Set to 100 to swap any stalled download regardless of progress.
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  id="stall-swap-max-progress"
                  min={0}
                  max={100}
                  step={1}
                  value={settings.automation.stallSwapMaxProgress}
                  onChange={(e) => {
                    const raw = Number.parseInt(e.target.value, 10);
                    const next = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 100) : 50;
                    onChange({
                      ...settings,
                      automation: {
                        ...settings.automation,
                        stallSwapMaxProgress: next,
                      },
                    });
                  }}
                  className="w-24 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-600 dark:text-gray-400">% progress</span>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700 mt-3">
          <div className="flex items-start gap-4">
            <div className="flex-1">
              <label
                htmlFor="global-block-threshold"
                className="block text-sm font-medium text-gray-900 dark:text-gray-100"
              >
                Globally block release after
              </label>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 mb-3">
                Independent stall failures of the <em>same release</em> before it gets promoted to a cross-request global block &mdash; meaning no request will be allowed to grab it again. Lower = more aggressive system-wide blocking.
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  id="global-block-threshold"
                  min={1}
                  max={100}
                  step={1}
                  value={settings.automation.globalBlockThreshold}
                  onChange={(e) => {
                    const raw = Number.parseInt(e.target.value, 10);
                    const next = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 100) : 3;
                    onChange({
                      ...settings,
                      automation: {
                        ...settings.automation,
                        globalBlockThreshold: next,
                      },
                    });
                  }}
                  className="w-24 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-600 dark:text-gray-400">stalls</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
        <IndexerManagement
          prowlarrUrl={settings.prowlarr.url}
          prowlarrApiKey={settings.prowlarr.apiKey}
          mode="settings"
          initialIndexers={indexers}
          onIndexersChange={onIndexersChange}
        />
      </div>

      {/* Flag Configuration Section */}
      <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
        <div className="mb-4">
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
            Indexer Flag Configuration (Optional)
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Configure score bonuses or penalties for indexer flags like "Freeleech".
            These modifiers apply universally across all indexers and affect final torrent ranking.
          </p>
        </div>

        {flagConfigs.length > 0 && (
          <div className="space-y-3 mb-4">
            {flagConfigs.map((config, index) => (
              <FlagConfigRow
                key={index}
                config={config}
                onChange={(updated) => {
                  const newConfigs = [...flagConfigs];
                  newConfigs[index] = updated;
                  onFlagConfigsChange(newConfigs);
                }}
                onRemove={() => {
                  onFlagConfigsChange(flagConfigs.filter((_, i) => i !== index));
                }}
              />
            ))}
          </div>
        )}

        <Button
          onClick={() => {
            onFlagConfigsChange([...flagConfigs, { name: '', modifier: 0 }]);
          }}
          variant="outline"
          size="sm"
        >
          + Add Flag Rule
        </Button>

        {flagConfigs.length === 0 && (
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-3 italic">
            No flag rules configured. Flag bonuses/penalties are optional.
          </p>
        )}
      </div>

      {/* Confirmation modal for Prowlarr connection change */}
      <ConfirmModal
        isOpen={showConnectionChangeConfirm}
        onClose={cancelConnectionChange}
        onConfirm={confirmConnectionChange}
        title="Prowlarr Connection Change"
        message={`Changing your Prowlarr connection will remove your ${configuredIndexersCount} configured indexer${configuredIndexersCount === 1 ? '' : 's'}. Indexer IDs are specific to each Prowlarr instance, so existing configurations cannot be preserved. You will need to re-add indexers from the new instance after saving.`}
        confirmText="Continue"
        cancelText="Cancel"
        variant="danger"
        isLoading={testing}
      />
    </div>
  );
}

import {
  AlertTriangle,
  Edit3,
  Eye,
  EyeOff,
  LoaderCircle,
  MessageSquareText,
  Minus,
  Moon,
  Plus,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  AI_PROMPT_MAX_LENGTH,
  DEFAULT_ARTICLE_SUMMARY_PROMPT,
  DEFAULT_ARTICLE_TRANSLATION_PROMPT,
} from "../../shared/ai-prompts";
import type {
  AiCustomPrompt,
  AiProvider,
  AiSettings,
  AppSettings,
  DuplicateArticleWindowDays,
} from "../../shared/types";
import { DUPLICATE_ARTICLE_WINDOW_DAYS } from "../../shared/types";
import { api, errorMessage } from "../api";
import type { ReaderDataMutations } from "../data-resource";
import { ExportOpmlLink, formatRefreshInterval, ImportOpmlButton, Kbd, PageHeader } from "./shared";
import { ShortcutReference } from "./shortcut-help";
import "./dialogs.css";
import "./settings.css";

type Theme = "dark" | "light";

function AiSettingsSection({
  settings,
  aiSettings,
  onSettings,
  onAiSettings,
  showToast,
}: {
  settings: AppSettings;
  aiSettings: AiSettings;
  onSettings: (settings: AppSettings) => void;
  onAiSettings: (settings: AiSettings) => void;
  showToast: (message: string) => void;
}) {
  const initialFeature = aiSettings.features.articleSummary;
  const initialProvider = initialFeature?.provider ?? "gemini";
  const initialModel =
    initialFeature?.model ??
    aiSettings.providers.find((provider) => provider.id === initialProvider)?.defaultModel ??
    "";
  const [providerId, setProviderId] = useState<AiProvider>(initialProvider);
  const [modelId, setModelId] = useState(initialModel);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [savingFeature, setSavingFeature] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [removingKey, setRemovingKey] = useState(false);
  const [savingPrompts, setSavingPrompts] = useState(false);
  const [savingCustomPrompt, setSavingCustomPrompt] = useState(false);
  const [summaryPrompt, setSummaryPrompt] = useState(settings.summaryPrompt);
  const [translationPrompt, setTranslationPrompt] = useState(settings.translationPrompt);
  const [editingCustomPrompt, setEditingCustomPrompt] = useState<AiCustomPrompt | null>(null);
  const [customPromptName, setCustomPromptName] = useState("");
  const [customPromptText, setCustomPromptText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [customPromptError, setCustomPromptError] = useState<string | null>(null);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const promptDialogRef = useRef<HTMLDialogElement>(null);
  const summaryPromptRef = useRef<HTMLTextAreaElement>(null);
  const customPromptDialogRef = useRef<HTMLDialogElement>(null);
  const customPromptNameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const feature = aiSettings.features.articleSummary;
    const nextProviderId = feature?.provider ?? "gemini";
    const nextProvider = aiSettings.providers.find((provider) => provider.id === nextProviderId);
    setProviderId(nextProviderId);
    setModelId(feature?.model ?? nextProvider?.defaultModel ?? "");
  }, [aiSettings]);

  useEffect(() => {
    setSummaryPrompt(settings.summaryPrompt);
    setTranslationPrompt(settings.translationPrompt);
  }, [settings.summaryPrompt, settings.translationPrompt]);

  const provider = aiSettings.providers.find((option) => option.id === providerId);
  if (!provider) return null;
  const activeFeature = aiSettings.features.articleSummary;
  const modelChanged =
    activeFeature?.provider !== providerId || activeFeature?.model !== modelId.trim();
  const promptsChanged =
    summaryPrompt.trim() !== settings.summaryPrompt ||
    translationPrompt.trim() !== settings.translationPrompt;
  const defaultPromptsSelected =
    summaryPrompt.trim() === DEFAULT_ARTICLE_SUMMARY_PROMPT &&
    translationPrompt.trim() === DEFAULT_ARTICLE_TRANSLATION_PROMPT;
  const busy = savingFeature || savingKey || removingKey || savingPrompts || savingCustomPrompt;

  const updateFeature = async (nextProvider: AiProvider, nextModel: string) => {
    setSavingFeature(true);
    setError(null);
    try {
      onAiSettings(
        await api.updateAiFeature("article_summary", {
          provider: nextProvider,
          model: nextModel.trim(),
        }),
      );
      showToast("AI model saved");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSavingFeature(false);
    }
  };

  const selectProvider = (nextProviderId: AiProvider) => {
    const nextProvider = aiSettings.providers.find((option) => option.id === nextProviderId);
    if (!nextProvider) return;
    setProviderId(nextProviderId);
    setModelId(
      activeFeature?.provider === nextProviderId ? activeFeature.model : nextProvider.defaultModel,
    );
    setApiKey("");
    setShowKey(false);
    setError(null);
    window.requestAnimationFrame(() => modelInputRef.current?.focus());
  };

  const saveModel = async (event: FormEvent) => {
    event.preventDefault();
    if (!modelId.trim()) return;
    await updateFeature(providerId, modelId);
  };

  const saveKey = async (event: FormEvent) => {
    event.preventDefault();
    const nextKey = apiKey.trim();
    const nextModel = modelId.trim();
    if (!nextKey || !nextModel) return;
    setSavingKey(true);
    setError(null);
    try {
      const keySettings = await api.saveAiProviderKey(providerId, nextKey);
      try {
        const updated = await api.updateAiFeature("article_summary", {
          provider: providerId,
          model: nextModel,
        });
        onAiSettings(updated);
        setApiKey("");
        setShowKey(false);
        showToast(`${provider.label} API key saved for summaries and translations`);
      } catch (caught) {
        onAiSettings(keySettings);
        throw caught;
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSavingKey(false);
    }
  };

  const removeKey = async () => {
    if (
      !window.confirm(
        `Remove the ${provider.label} API key? New summaries and translations will stop until another key is saved.`,
      )
    ) {
      return;
    }
    setRemovingKey(true);
    setError(null);
    try {
      onAiSettings(await api.deleteAiProviderKey(providerId));
      setApiKey("");
      setShowKey(false);
      showToast(`${provider.label} API key removed`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setRemovingKey(false);
    }
  };

  const openPromptDialog = () => {
    setSummaryPrompt(settings.summaryPrompt);
    setTranslationPrompt(settings.translationPrompt);
    setPromptError(null);
    promptDialogRef.current?.showModal();
    window.requestAnimationFrame(() => summaryPromptRef.current?.focus());
  };

  const closePromptDialog = () => {
    if (!savingPrompts) promptDialogRef.current?.close();
  };

  const resetPromptDraft = () => {
    setSummaryPrompt(settings.summaryPrompt);
    setTranslationPrompt(settings.translationPrompt);
    setPromptError(null);
  };

  const savePrompts = async (event: FormEvent) => {
    event.preventDefault();
    const nextSummaryPrompt = summaryPrompt.trim();
    const nextTranslationPrompt = translationPrompt.trim();
    if (!nextSummaryPrompt || !nextTranslationPrompt || !promptsChanged) return;
    setSavingPrompts(true);
    setError(null);
    setPromptError(null);
    try {
      onSettings(
        await api.updateSettings({
          summaryPrompt: nextSummaryPrompt,
          translationPrompt: nextTranslationPrompt,
        }),
      );
      showToast("AI prompts saved");
      promptDialogRef.current?.close();
    } catch (caught) {
      setPromptError(errorMessage(caught));
    } finally {
      setSavingPrompts(false);
    }
  };

  const openCustomPromptDialog = (prompt?: AiCustomPrompt) => {
    setEditingCustomPrompt(prompt ?? null);
    setCustomPromptName(prompt?.name ?? "");
    setCustomPromptText(prompt?.prompt ?? "");
    setCustomPromptError(null);
    customPromptDialogRef.current?.showModal();
    window.requestAnimationFrame(() => customPromptNameRef.current?.focus());
  };

  const closeCustomPromptDialog = () => {
    if (!savingCustomPrompt) customPromptDialogRef.current?.close();
  };

  const saveCustomPrompt = async (event: FormEvent) => {
    event.preventDefault();
    const name = customPromptName.trim();
    const prompt = customPromptText.trim();
    if (!name || !prompt) return;
    const nextPrompt: AiCustomPrompt = {
      id: editingCustomPrompt?.id ?? crypto.randomUUID(),
      name,
      prompt,
    };
    const customPrompts = editingCustomPrompt
      ? settings.customPrompts.map((item) =>
          item.id === editingCustomPrompt.id ? nextPrompt : item,
        )
      : [...settings.customPrompts, nextPrompt];
    setSavingCustomPrompt(true);
    setCustomPromptError(null);
    try {
      onSettings(await api.updateSettings({ customPrompts }));
      showToast(editingCustomPrompt ? "Custom prompt updated" : "Custom prompt added");
      customPromptDialogRef.current?.close();
    } catch (caught) {
      setCustomPromptError(errorMessage(caught));
    } finally {
      setSavingCustomPrompt(false);
    }
  };

  const deleteCustomPrompt = async (prompt: AiCustomPrompt) => {
    if (!window.confirm(`Delete the custom prompt “${prompt.name}”?`)) return;
    setSavingCustomPrompt(true);
    setError(null);
    try {
      onSettings(
        await api.updateSettings({
          customPrompts: settings.customPrompts.filter((item) => item.id !== prompt.id),
        }),
      );
      showToast("Custom prompt deleted");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSavingCustomPrompt(false);
    }
  };

  return (
    <section
      id="ai-settings"
      className="settings-section ai-settings-section"
      aria-labelledby="ai-heading"
    >
      <div className="settings-heading">
        <div>
          <h2 id="ai-heading">AI</h2>
          <p>One provider and model creates summaries and article translations.</p>
        </div>
        {busy ? (
          <span className="saving-label" role="status">
            <LoaderCircle className="spin" aria-hidden="true" size={15} />
            Saving
          </span>
        ) : null}
      </div>

      {!aiSettings.credentialStorageAvailable ? (
        <div className="ai-settings-warning" role="alert">
          <AlertTriangle aria-hidden="true" size={17} />
          <span>
            Set <code>AI_CREDENTIALS_KEY</code>, then restart or recreate the server to store
            provider keys.
          </span>
        </div>
      ) : null}

      <div className="setting-row">
        <label htmlFor="ai-summary-provider">
          <strong>Provider</strong>
          <p>Used when a summary or translation is generated.</p>
        </label>
        <div className="ai-provider-control">
          <select
            id="ai-summary-provider"
            value={providerId}
            disabled={busy || !aiSettings.credentialStorageAvailable}
            onChange={(event) => selectProvider(event.target.value as AiProvider)}
          >
            {aiSettings.providers.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
                {option.configured ? " (key saved)" : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="setting-row">
        <label htmlFor="ai-summary-model">
          <strong>Model</strong>
          <p id="ai-summary-model-help">
            Enter the exact {provider.label} model ID. Default: <code>{provider.defaultModel}</code>
            .
          </p>
        </label>
        <form className="ai-model-form" onSubmit={(event) => void saveModel(event)}>
          <input
            ref={modelInputRef}
            id="ai-summary-model"
            type="text"
            value={modelId}
            placeholder={provider.defaultModel}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={200}
            required
            aria-describedby="ai-summary-model-help"
            disabled={busy || !aiSettings.credentialStorageAvailable}
            onChange={(event) => {
              setModelId(event.target.value);
              setError(null);
            }}
          />
          <button
            className="secondary-button"
            type="submit"
            disabled={
              !modelId.trim() || !modelChanged || busy || !aiSettings.credentialStorageAvailable
            }
          >
            {savingFeature ? <LoaderCircle className="spin" aria-hidden="true" size={15} /> : null}
            Save model
          </button>
        </form>
      </div>

      <div className="setting-row ai-key-row">
        <div>
          <strong>{provider.label} API key</strong>
          <p id="ai-api-key-help">
            {provider.configured
              ? "A key is saved. Paste another key only to replace it."
              : "The key is encrypted on this server and never shown again."}
          </p>
        </div>
        <form className="ai-key-form" onSubmit={(event) => void saveKey(event)}>
          <div className="ai-key-input">
            <label className="sr-only" htmlFor="ai-api-key">
              {provider.label} API key
            </label>
            <input
              ref={keyInputRef}
              id="ai-api-key"
              type={showKey ? "text" : "password"}
              value={apiKey}
              placeholder={provider.configured ? "Paste a replacement key" : "Paste API key"}
              autoComplete="new-password"
              autoCapitalize="none"
              spellCheck={false}
              aria-describedby="ai-api-key-help"
              disabled={busy || !aiSettings.credentialStorageAvailable}
              onChange={(event) => {
                setApiKey(event.target.value);
                setError(null);
              }}
            />
            <button
              className="icon-button"
              type="button"
              disabled={!apiKey || busy}
              aria-label={showKey ? "Hide API key" : "Show API key"}
              aria-pressed={showKey}
              onClick={() => setShowKey((current) => !current)}
            >
              {showKey ? (
                <EyeOff aria-hidden="true" size={16} />
              ) : (
                <Eye aria-hidden="true" size={16} />
              )}
            </button>
          </div>
          <button
            className="primary-button"
            type="submit"
            disabled={
              !apiKey.trim() || !modelId.trim() || busy || !aiSettings.credentialStorageAvailable
            }
          >
            {savingKey ? <LoaderCircle className="spin" aria-hidden="true" size={15} /> : null}
            {provider.configured ? "Replace key" : "Save key"}
          </button>
          {provider.configured ? (
            <button
              className="secondary-button ai-key-remove"
              type="button"
              disabled={busy || !aiSettings.credentialStorageAvailable}
              onClick={() => void removeKey()}
            >
              Remove key
            </button>
          ) : null}
        </form>
      </div>

      {error ? (
        <div className="ai-settings-error" role="alert">
          <AlertTriangle aria-hidden="true" size={16} />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="setting-row">
        <div>
          <strong>Default prompts</strong>
          <p>Edit the built-in summary and translation instructions.</p>
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={busy}
          onClick={openPromptDialog}
        >
          <Edit3 aria-hidden="true" size={15} />
          Edit defaults
        </button>
      </div>

      <div className="custom-prompts-setting">
        <div className="custom-prompts-heading">
          <div>
            <strong>Custom prompts</strong>
            <p>Run saved instructions on any article from the AI prompt menu.</p>
          </div>
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={() => openCustomPromptDialog()}
          >
            <Plus aria-hidden="true" size={15} />
            Add prompt
          </button>
        </div>
        {settings.customPrompts.length > 0 ? (
          <ul className="custom-prompt-list">
            {settings.customPrompts.map((prompt) => (
              <li className="custom-prompt-list-item" key={prompt.id}>
                <div>
                  <strong>{prompt.name}</strong>
                  <p>{prompt.prompt}</p>
                </div>
                <div className="custom-prompt-actions">
                  <button
                    className="icon-button"
                    type="button"
                    disabled={busy}
                    aria-label={`Edit ${prompt.name}`}
                    onClick={() => openCustomPromptDialog(prompt)}
                  >
                    <Edit3 aria-hidden="true" size={15} />
                  </button>
                  <button
                    className="icon-button danger-action"
                    type="button"
                    disabled={busy}
                    aria-label={`Delete ${prompt.name}`}
                    onClick={() => void deleteCustomPrompt(prompt)}
                  >
                    <Trash2 aria-hidden="true" size={15} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="custom-prompts-empty">No custom prompts yet.</p>
        )}
      </div>

      <dialog
        ref={promptDialogRef}
        className="management-dialog is-wide ai-prompt-dialog"
        aria-labelledby="ai-prompt-dialog-title"
        onClose={resetPromptDraft}
        onCancel={(event) => {
          if (savingPrompts) event.preventDefault();
        }}
      >
        <form className="ai-prompt-dialog-form" onSubmit={(event) => void savePrompts(event)}>
          <header className="management-dialog-heading">
            <span className="dialog-icon" aria-hidden="true">
              <Edit3 size={16} />
            </span>
            <div>
              <h2 id="ai-prompt-dialog-title">Edit default prompts</h2>
              <p>These instructions are used by Summarize and Translate.</p>
            </div>
            <button
              className="icon-button"
              type="button"
              disabled={savingPrompts}
              onClick={closePromptDialog}
              aria-label="Close prompt editor"
            >
              <X aria-hidden="true" size={18} />
            </button>
          </header>

          <div className="management-dialog-body ai-prompt-dialog-body">
            <label className="ai-prompt-field" htmlFor="ai-summary-prompt">
              <span>Summary prompt</span>
              <p id="ai-summary-prompt-help">
                Controls the structure, detail, and tone of summaries.
              </p>
              <textarea
                ref={summaryPromptRef}
                id="ai-summary-prompt"
                value={summaryPrompt}
                rows={12}
                maxLength={AI_PROMPT_MAX_LENGTH}
                required
                disabled={savingPrompts}
                aria-describedby="ai-summary-prompt-help"
                onChange={(event) => {
                  setSummaryPrompt(event.target.value);
                  setPromptError(null);
                }}
              />
            </label>
            <label className="ai-prompt-field" htmlFor="ai-translation-prompt">
              <span>Translation prompt</span>
              <p id="ai-translation-prompt-help">
                Keep the JSON and data-translation-id requirements so translated articles can be
                rebuilt.
              </p>
              <textarea
                id="ai-translation-prompt"
                value={translationPrompt}
                rows={12}
                maxLength={AI_PROMPT_MAX_LENGTH}
                required
                disabled={savingPrompts}
                aria-describedby="ai-translation-prompt-help"
                onChange={(event) => {
                  setTranslationPrompt(event.target.value);
                  setPromptError(null);
                }}
              />
            </label>

            {promptError ? (
              <div className="management-dialog-error" role="alert">
                <AlertTriangle aria-hidden="true" size={16} />
                <span>{promptError}</span>
              </div>
            ) : null}
          </div>

          <footer className="management-dialog-footer">
            <button
              className="secondary-button"
              type="button"
              disabled={savingPrompts || defaultPromptsSelected}
              onClick={() => {
                setSummaryPrompt(DEFAULT_ARTICLE_SUMMARY_PROMPT);
                setTranslationPrompt(DEFAULT_ARTICLE_TRANSLATION_PROMPT);
                setPromptError(null);
              }}
            >
              Restore defaults
            </button>
            <div>
              <button
                className="secondary-button"
                type="button"
                disabled={savingPrompts}
                onClick={closePromptDialog}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="submit"
                disabled={
                  savingPrompts ||
                  !summaryPrompt.trim() ||
                  !translationPrompt.trim() ||
                  !promptsChanged
                }
              >
                {savingPrompts ? (
                  <LoaderCircle className="spin" aria-hidden="true" size={15} />
                ) : null}
                Save prompts
              </button>
            </div>
          </footer>
        </form>
      </dialog>

      <dialog
        ref={customPromptDialogRef}
        className="management-dialog custom-prompt-dialog"
        aria-labelledby="custom-prompt-dialog-title"
        onClose={() => setCustomPromptError(null)}
        onCancel={(event) => {
          if (savingCustomPrompt) event.preventDefault();
        }}
      >
        <form className="custom-prompt-form" onSubmit={(event) => void saveCustomPrompt(event)}>
          <header className="management-dialog-heading">
            <span className="dialog-icon" aria-hidden="true">
              <MessageSquareText size={16} />
            </span>
            <div>
              <h2 id="custom-prompt-dialog-title">
                {editingCustomPrompt ? "Edit custom prompt" : "Add custom prompt"}
              </h2>
              <p>The article title and text are included automatically.</p>
            </div>
            <button
              className="icon-button"
              type="button"
              disabled={savingCustomPrompt}
              onClick={closeCustomPromptDialog}
              aria-label="Close custom prompt editor"
            >
              <X aria-hidden="true" size={18} />
            </button>
          </header>

          <div className="management-dialog-body custom-prompt-dialog-body">
            <label htmlFor="custom-prompt-name">
              <span>Name</span>
              <p id="custom-prompt-name-help">Shown in the article prompt menu.</p>
              <input
                ref={customPromptNameRef}
                id="custom-prompt-name"
                type="text"
                value={customPromptName}
                maxLength={80}
                required
                disabled={savingCustomPrompt}
                aria-describedby="custom-prompt-name-help"
                onChange={(event) => {
                  setCustomPromptName(event.target.value);
                  setCustomPromptError(null);
                }}
              />
            </label>
            <label htmlFor="custom-prompt-text">
              <span>Prompt</span>
              <p id="custom-prompt-text-help">
                Tell the AI how to analyze or transform the article.
              </p>
              <textarea
                id="custom-prompt-text"
                value={customPromptText}
                rows={10}
                maxLength={AI_PROMPT_MAX_LENGTH}
                required
                disabled={savingCustomPrompt}
                aria-describedby="custom-prompt-text-help"
                onChange={(event) => {
                  setCustomPromptText(event.target.value);
                  setCustomPromptError(null);
                }}
              />
            </label>
            {customPromptError ? (
              <div className="management-dialog-error" role="alert">
                <AlertTriangle aria-hidden="true" size={16} />
                <span>{customPromptError}</span>
              </div>
            ) : null}
          </div>

          <footer className="management-dialog-footer">
            <span />
            <div>
              <button
                className="secondary-button"
                type="button"
                disabled={savingCustomPrompt}
                onClick={closeCustomPromptDialog}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="submit"
                disabled={
                  savingCustomPrompt || !customPromptName.trim() || !customPromptText.trim()
                }
              >
                {savingCustomPrompt ? (
                  <LoaderCircle className="spin" aria-hidden="true" size={15} />
                ) : null}
                {editingCustomPrompt ? "Save prompt" : "Add prompt"}
              </button>
            </div>
          </footer>
        </form>
      </dialog>
    </section>
  );
}

export function SettingsPage({
  settings,
  aiSettings,
  theme,
  fontSize,
  mutations,
  onMenu,
  onTheme,
  onFontSize,
  onSettings,
  onAiSettings,
  showToast,
}: {
  settings: AppSettings;
  aiSettings: AiSettings;
  theme: Theme;
  fontSize: number;
  mutations: ReaderDataMutations;
  onMenu: () => void;
  onTheme: (theme: Theme) => void;
  onFontSize: (value: number | ((current: number) => number)) => void;
  onSettings: (settings: AppSettings) => void;
  onAiSettings: (settings: AiSettings) => void;
  showToast: (message: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [translationLanguage, setTranslationLanguage] = useState(settings.translationLanguage);

  useEffect(() => {
    setTranslationLanguage(settings.translationLanguage);
  }, [settings.translationLanguage]);

  const saveSettings = async (change: Partial<AppSettings>) => {
    setSaving(true);
    try {
      onSettings(await api.updateSettings(change));
      showToast("Settings saved");
    } catch (error) {
      showToast(`Could not save settings: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="management-page settings-page">
      <PageHeader
        title="Settings"
        description="Reading preferences, AI, polling, shortcuts, and portable subscriptions for this account."
        onMenu={onMenu}
        actions={
          saving ? (
            <span className="saving-label">
              <LoaderCircle className="spin" aria-hidden="true" size={15} />
              Saving
            </span>
          ) : undefined
        }
      />
      <section className="settings-section" aria-labelledby="appearance-heading">
        <div className="settings-heading">
          <h2 id="appearance-heading">Appearance</h2>
          <p>Saved for this account in this browser.</p>
        </div>
        <div className="setting-row">
          <div>
            <strong>Theme</strong>
            <p>Dark is the default for evening reading.</p>
          </div>
          <div className="theme-options">
            <button type="button" aria-pressed={theme === "dark"} onClick={() => onTheme("dark")}>
              <Moon aria-hidden="true" size={17} />
              Dark
            </button>
            <button type="button" aria-pressed={theme === "light"} onClick={() => onTheme("light")}>
              <Sun aria-hidden="true" size={17} />
              Light
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>Article text size</strong>
            <p>One saved size applies to every full article in reader and expanded views.</p>
          </div>
          <div className="font-stepper">
            <button
              type="button"
              disabled={fontSize <= 15}
              onClick={() => onFontSize((current) => Math.max(15, current - 1))}
              aria-label="Decrease article text size"
            >
              <Minus aria-hidden="true" size={16} />
              <Kbd>[</Kbd>
            </button>
            <output>{fontSize}px</output>
            <button
              type="button"
              disabled={fontSize >= 23}
              onClick={() => onFontSize((current) => Math.min(23, current + 1))}
              aria-label="Increase article text size"
            >
              <Plus aria-hidden="true" size={16} />
              <Kbd>]</Kbd>
            </button>
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="reading-behavior-heading">
        <div className="settings-heading">
          <h2 id="reading-behavior-heading">Reading behavior</h2>
          <p>Applied consistently across feeds and folders.</p>
        </div>
        <div className="setting-row">
          <div>
            <strong>Mark read on scroll</strong>
            <p>Mark an unread card or expanded article only after you scroll completely past it.</p>
          </div>
          <button
            className={`switch ${settings.markReadOnScroll ? "is-on" : ""}`}
            type="button"
            role="switch"
            aria-checked={settings.markReadOnScroll}
            disabled={saving}
            onClick={() => void saveSettings({ markReadOnScroll: !settings.markReadOnScroll })}
          >
            <span />
          </button>
        </div>
        <div className="setting-row">
          <label htmlFor="translation-language">
            <strong>Translation language</strong>
            <p>Article translations use this language and the AI model configured below.</p>
          </label>
          <form
            className="translation-language-form"
            onSubmit={(event) => {
              event.preventDefault();
              const language = translationLanguage.trim();
              if (language) void saveSettings({ translationLanguage: language });
            }}
          >
            <input
              id="translation-language"
              list="translation-language-suggestions"
              value={translationLanguage}
              maxLength={80}
              required
              disabled={saving}
              onChange={(event) => setTranslationLanguage(event.target.value)}
            />
            <datalist id="translation-language-suggestions">
              <option value="English" />
              <option value="Polish" />
              <option value="German" />
              <option value="Spanish" />
              <option value="French" />
              <option value="Italian" />
              <option value="Portuguese" />
              <option value="Ukrainian" />
            </datalist>
            <button
              className="secondary-button"
              type="submit"
              disabled={
                saving ||
                !translationLanguage.trim() ||
                translationLanguage.trim() === settings.translationLanguage
              }
            >
              Save language
            </button>
          </form>
        </div>
      </section>

      <AiSettingsSection
        settings={settings}
        aiSettings={aiSettings}
        onSettings={onSettings}
        onAiSettings={onAiSettings}
        showToast={showToast}
      />

      <section className="settings-section" aria-labelledby="refresh-heading">
        <div className="settings-heading">
          <h2 id="refresh-heading">Refresh</h2>
          <p>Background polling continues while the server is running.</p>
        </div>
        <div className="setting-row">
          <label htmlFor="poll-interval">
            <strong>Published feed interval</strong>
            <p>
              How often Echovale checks RSS, Atom, and JSON feeds. Web feeds refresh every 3 hours.
            </p>
          </label>
          <select
            id="poll-interval"
            value={settings.pollIntervalMinutes}
            disabled={saving}
            onChange={(event) =>
              void saveSettings({ pollIntervalMinutes: Number(event.target.value) })
            }
          >
            {[5, 10, 15, 30, 60, 120].map((minutes) => (
              <option key={minutes} value={minutes}>
                {formatRefreshInterval(minutes)}
              </option>
            ))}
          </select>
        </div>
        <div className="setting-row">
          <label htmlFor="duplicate-article-window">
            <strong>Duplicate article window</strong>
            <p>
              Skip a new article when its exact URL or exact title appeared in any feed during this
              period.
            </p>
          </label>
          <select
            id="duplicate-article-window"
            value={settings.duplicateArticleWindowDays}
            disabled={saving}
            onChange={(event) =>
              void saveSettings({
                duplicateArticleWindowDays: Number(
                  event.target.value,
                ) as DuplicateArticleWindowDays,
              })
            }
          >
            {DUPLICATE_ARTICLE_WINDOW_DAYS.map((days) => (
              <option key={days} value={days}>
                {days === 1 ? "Past day" : `Past ${days} days`}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="keyboard-heading">
        <div className="settings-heading">
          <h2 id="keyboard-heading">Keyboard</h2>
          <p>Shortcuts pause while typing in any field.</p>
        </div>
        <div className="setting-row">
          <div>
            <strong>Single-key shortcuts</strong>
            <p>Turn off navigation and action shortcuts without affecting normal tab navigation.</p>
          </div>
          <button
            className={`switch ${settings.singleKeyShortcuts ? "is-on" : ""}`}
            type="button"
            role="switch"
            aria-checked={settings.singleKeyShortcuts}
            disabled={saving}
            onClick={() => void saveSettings({ singleKeyShortcuts: !settings.singleKeyShortcuts })}
          >
            <span />
          </button>
        </div>
        <ShortcutReference compact />
      </section>

      <section className="settings-section" aria-labelledby="portable-heading">
        <div className="settings-heading">
          <h2 id="portable-heading">Subscriptions</h2>
          <p>OPML keeps folder structure and feed URLs portable.</p>
        </div>
        <div className="setting-row">
          <div>
            <strong>Import or export OPML</strong>
            <p>Imports skip subscriptions that already exist.</p>
          </div>
          <div className="settings-actions">
            <ImportOpmlButton mutations={mutations} showToast={showToast} />
            <ExportOpmlLink />
          </div>
        </div>
      </section>
    </div>
  );
}

export default SettingsPage;

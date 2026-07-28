import { useEffect, useState } from "react";
import type { ReadingMode } from "../shared/types";

export type Theme = "dark" | "light";

export const ARTICLE_FONT_MIN = 15;
export const ARTICLE_FONT_MAX = 23;
const ARTICLE_FONT_DEFAULT = 18;

function storedValue<T extends string>(key: string, fallback: T): T {
  const value = window.localStorage.getItem(key);
  return (value as T | null) ?? fallback;
}

function storedNumber(key: string, fallback: number): number {
  const stored = window.localStorage.getItem(key);
  if (stored === null) return fallback;
  const value = Number(stored);
  return Number.isFinite(value) ? value : fallback;
}

function accountStorageKey(userId: number, setting: string): string {
  return `echovale-account-${userId}-${setting}`;
}

export function useReaderPreferences(userId: number) {
  const [readingMode, setReadingMode] = useState<ReadingMode>(() =>
    storedValue<ReadingMode>(accountStorageKey(userId, "reading-mode"), "magazine"),
  );
  const [theme, setTheme] = useState<Theme>(() =>
    storedValue<Theme>(accountStorageKey(userId, "theme"), "dark"),
  );
  const [articleFontSize, setArticleFontSize] = useState(() =>
    Math.min(
      ARTICLE_FONT_MAX,
      Math.max(
        ARTICLE_FONT_MIN,
        storedNumber(accountStorageKey(userId, "article-font-size"), ARTICLE_FONT_DEFAULT),
      ),
    ),
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(accountStorageKey(userId, "theme"), theme);
  }, [theme, userId]);

  useEffect(() => {
    document.documentElement.style.setProperty("--article-font-size", `${articleFontSize}px`);
    window.localStorage.setItem(
      accountStorageKey(userId, "article-font-size"),
      String(articleFontSize),
    );
  }, [articleFontSize, userId]);

  useEffect(() => {
    window.localStorage.setItem(accountStorageKey(userId, "reading-mode"), readingMode);
  }, [readingMode, userId]);

  return {
    readingMode,
    setReadingMode,
    theme,
    setTheme,
    articleFontSize,
    setArticleFontSize,
  };
}

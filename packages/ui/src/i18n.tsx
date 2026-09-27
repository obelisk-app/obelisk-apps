/**
 * The games' strings, extracted from obelisk-dex's locale files (every
 * `games.*` key plus the handful of shared ones the table uses). Same `t(key)`
 * shape as dex's `useTranslation`, so the ported components didn't change.
 * The locale comes from the host's `init.locale` / `env` push.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';

import en from './locales/en.json';
import es from './locales/es.json';
import pt from './locales/pt.json';

export type Locale = 'en' | 'es' | 'pt';

const dictionaries: Record<Locale, Record<string, string>> = { en, es, pt };

export function translator(locale: Locale): (key: string) => string {
  const dict = dictionaries[locale] ?? dictionaries.es;
  return (key: string) => dict[key] ?? dictionaries.en[key] ?? key;
}

const I18nContext = createContext<{ locale: Locale; t: (key: string) => string } | null>(null);

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo(() => ({ locale, t: translator(locale) }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslation() {
  const ctx = useContext(I18nContext);
  // Outside a provider (a component test), fall back to English rather than throw.
  return ctx ?? { locale: 'en' as Locale, t: translator('en') };
}

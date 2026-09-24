import { LANGUAGES, useLanguage, useT } from "@/i18n";
import { alternates, canonicalUrl, isIndexable, type PageSeo } from "@/lib/seo";
import { useEffect } from "react";

function setMeta(attr: "name" | "property", key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function setLink(rel: string, href: string) {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", rel);
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}

function setAlternates(path: string, enabled: boolean) {
  document.head.querySelectorAll('link[rel="alternate"][hreflang]').forEach((el) => el.remove());
  if (!enabled) return;
  for (const link of alternates(path)) {
    const el = document.createElement("link");
    el.setAttribute("rel", "alternate");
    el.setAttribute("hreflang", link.hrefLang);
    el.setAttribute("href", link.href);
    document.head.appendChild(el);
  }
}

function setOgLocales(active: string, withAlternates: boolean) {
  document.head.querySelectorAll('meta[property="og:locale"]').forEach((el) => el.remove());
  document.head
    .querySelectorAll('meta[property="og:locale:alternate"]')
    .forEach((el) => el.remove());
  setMeta("property", "og:locale", active);
  if (!withAlternates) return;
  for (const spec of Object.values(LANGUAGES)) {
    if (spec.ogLocale === active) continue;
    const el = document.createElement("meta");
    el.setAttribute("property", "og:locale:alternate");
    el.setAttribute("content", spec.ogLocale);
    document.head.appendChild(el);
  }
}

export function useSEO(page: PageSeo) {
  const T = useT();
  const language = useLanguage();
  const title = T(page.titleKey);
  const description = T(page.descriptionKey);
  const { path, type, noIndex, translated } = page;

  useEffect(() => {
    const url = canonicalUrl(language, path);
    const indexable = isIndexable(page, language);
    document.title = title;
    setMeta("name", "description", description);
    setMeta(
      "name",
      "robots",
      noIndex ? "noindex, nofollow" : indexable ? "index, follow" : "noindex, follow",
    );
    if (!noIndex) setLink("canonical", url);
    setMeta("property", "og:type", type);
    setMeta("property", "og:title", title);
    setMeta("property", "og:description", description);
    setMeta("property", "og:url", url);
    setMeta("name", "twitter:title", title);
    setMeta("name", "twitter:description", description);
    setOgLocales(LANGUAGES[language].ogLocale, translated === true);
    setAlternates(path, translated === true && noIndex !== true);
  }, [page, title, description, path, type, noIndex, translated, language]);
}

import { useSEO } from "@/hooks/useSEO";
import { useDirection, useT } from "@/i18n";
import { NOT_FOUND_SEO } from "@/lib/seo";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";

export default function NotFoundPage() {
  const T = useT();
  const BackArrow = useDirection() === "rtl" ? ArrowRight : ArrowLeft;

  useSEO(NOT_FOUND_SEO);

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center"
    >
      <div className="flex flex-col items-center gap-4">
        <span className="label text-secondary text-[11px] font-semibold tracking-[0.2em]">404</span>
        <h1 className="text-ink text-3xl font-semibold tracking-tight sm:text-4xl">
          {T("page.notfound.title")}
        </h1>
        <p className="text-secondary mx-auto max-w-sm text-sm leading-relaxed">
          {T("page.notfound.body")}
        </p>
        <div className="pt-2">
          <Link
            to="/"
            className="group/btn bg-ink text-canvas inline-flex min-h-11 items-center gap-2 rounded-full px-6 text-sm font-medium transition-opacity duration-150 hover:opacity-90"
          >
            <BackArrow
              size={14}
              aria-hidden="true"
              className="transition-transform duration-150 group-hover/btn:-translate-x-0.5 rtl:group-hover/btn:translate-x-0.5"
            />
            {T("common.back_to_home")}
          </Link>
        </div>
      </div>
    </main>
  );
}

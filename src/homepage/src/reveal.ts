/**
 * 滚动渐入 —— IntersectionObserver 一次性 reveal（学习 Linear/Vercel 的
 * subtle fade-up：opacity + 14px 位移，decelerate 缓动，进入即定格）。
 * reduced-motion 用户直接可见（不加初始隐藏）。
 */
import { useEffect } from "react";

export function useReveal(): void {
  useEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const els = Array.from(document.querySelectorAll<HTMLElement>(".hp-reveal"));
    if (reduced || !("IntersectionObserver" in window)) {
      els.forEach((el) => el.classList.add("is-in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            io.unobserve(e.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

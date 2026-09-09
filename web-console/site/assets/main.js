(() => {
  "use strict";

  /* ---------- nav: glass background after scroll ---------- */
  const nav = document.getElementById("nav");
  const onScroll = () => {
    nav.classList.toggle("scrolled", window.scrollY > 8);
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  /* ---------- side dot nav: highlight current section ---------- */
  const dotLinks = Array.from(document.querySelectorAll(".side-nav a"));
  const spotSections = dotLinks
    .map((a) => {
      const id = (a.getAttribute("href") || "").slice(1);
      const el = document.getElementById(id);
      return el ? { a, el } : null;
    })
    .filter(Boolean);
  if (spotSections.length) {
    const onSpot = () => {
      const mark = window.scrollY + window.innerHeight * 0.42;
      let current = spotSections[0];
      spotSections.forEach((s) => {
        if (s.el.offsetTop <= mark) current = s;
      });
      dotLinks.forEach((a) => a.classList.toggle("active", a === current.a));
    };
    onSpot();
    window.addEventListener("scroll", onSpot, { passive: true });
  }

  /* ---------- reveal on scroll ---------- */
  const revealed = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window)) {
    document.documentElement.classList.add("no-observer");
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" }
    );
    revealed.forEach((el) => io.observe(el));
  }

  /* ---------- copy install command ---------- */
  const reset = (btn, label) => {
    window.setTimeout(() => {
      btn.classList.remove("done");
      btn.innerHTML = label;
    }, 1600);
  };

  document.querySelectorAll(".copy-btn[data-copy]").forEach((btn) => {
    const label = btn.innerHTML;
    btn.addEventListener("click", async () => {
      const text = btn.getAttribute("data-copy");
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      btn.classList.add("done");
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M20 6L9 17l-5-5"/></svg>';
      reset(btn, label);
    });
  });
})();

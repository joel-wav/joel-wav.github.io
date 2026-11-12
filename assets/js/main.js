// Typing terminal, mobile nav, scroll reveal.
(function () {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- terminal ----
  const term = document.getElementById("term");
  if (term) {
    const P = '<span class="prompt">joel@hyd</span>:<span class="path">~</span>$ ';
    const script = [
      { cmd: "whoami", out: "robotics & autonomy engineer @ MathWorks" },
      { cmd: "cat interests.txt", out:
          '<span class="key">multi_uav</span>        swarms · flight-log analysis\n' +
          '<span class="key">uav_dynamics</span>     6DoF models · PX4/ArduPilot SITL\n' +
          '<span class="key">control</span>          robust control, QFT\n' +
          '<span class="key">learning</span>         RL for planning' },
      { cmd: "ls ~/links", out: 'github/  linkedin/  <span class="key">blog/</span>' },
    ];
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const cursor = '<span class="cursor"></span>';

    if (reduce) {
      term.innerHTML = script.map((s) => P + esc(s.cmd) + "\n" + s.out + "\n").join("\n") + P + cursor;
    } else {
      let html = "";
      let i = 0;
      const step = () => {
        if (i >= script.length) { term.innerHTML = html + P + cursor; return; }
        const { cmd, out } = script[i];
        let c = 0;
        const type = () => {
          term.innerHTML = html + P + esc(cmd.slice(0, c)) + cursor;
          if (c++ < cmd.length) return setTimeout(type, 45 + Math.random() * 50);
          setTimeout(() => {
            html += P + esc(cmd) + "\n" + out + "\n\n";
            term.innerHTML = html + P + cursor;
            i++;
            setTimeout(step, 650);
          }, 300);
        };
        type();
      };
      setTimeout(step, 400);
    }
  }

  // ---- theme toggle (dark default) ----
  const root = document.documentElement;
  const tbtn = document.getElementById("theme-toggle");
  const label = () => {
    if (!tbtn) return;
    const light = root.getAttribute("data-theme") === "light";
    tbtn.textContent = light ? "[☾ dark]" : "[☀ light]";
    tbtn.setAttribute("aria-label", light ? "Switch to dark theme" : "Switch to light theme");
  };
  label();
  if (tbtn) {
    tbtn.addEventListener("click", () => {
      const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("theme", next); } catch (e) {}
      label();
    });
  }

  // ---- mobile nav ----
  const toggle = document.querySelector(".nav-toggle");
  const menu = document.querySelector(".nav ul");
  if (toggle && menu) {
    toggle.addEventListener("click", () => {
      const open = menu.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open);
    });
    menu.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => menu.classList.remove("open")));
  }

  // ---- reveal on scroll ----
  const els = document.querySelectorAll(".reveal");
  if (reduce || !("IntersectionObserver" in window)) {
    els.forEach((e) => e.classList.add("visible"));
  } else {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("visible"); io.unobserve(e.target); } });
    }, { threshold: 0.12 });
    els.forEach((e) => io.observe(e));
  }
})();

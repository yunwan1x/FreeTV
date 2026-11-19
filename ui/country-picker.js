// ISO 3166-1 alpha-2 codes, plus XK used by streaming directories.
const radioCodes =
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW".split(
    " ",
  );
const names = (lang) =>
  typeof Intl.DisplayNames === "function"
    ? new Intl.DisplayNames([lang], { type: "region" })
    : null;
const zh = names("zh-CN"),
  en = names("en");
export const countryLabel = (code) =>
  code === "?" ? "未标注地区" : zh?.of(code) || code;
export const radioCountries = radioCodes.map((code) => ({ code }));
const allLabel = "全部国家和地区";
const fold = (value) =>
  value
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

export function countryPicker(input, onChange) {
  const menu = document.createElement("div");
  menu.id = input.id + "-options";
  menu.className = "country-options";
  menu.setAttribute("role", "listbox");
  menu.hidden = true;
  document.body.append(menu);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", menu.id);
  input.setAttribute("aria-expanded", "false");
  const toggle = input.parentElement.querySelector("button");
  let options = [],
    matches = [],
    selected = "",
    active = -1;
  const label = (code) => (code ? countryLabel(code) : "");
  function position() {
    if (menu.hidden) return;
    const r = input.parentElement.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop || 0,
      bottom = top + (viewport?.height || innerHeight);
    const above = bottom - r.bottom < 160 && r.top - top > bottom - r.bottom;
    Object.assign(menu.style, {
      left: r.left + "px",
      width: r.width + "px",
      top: above ? "auto" : r.bottom + "px",
      bottom: above ? innerHeight - r.top + "px" : "auto",
      maxHeight:
        Math.max(
          48,
          Math.min(245, above ? r.top - top - 4 : bottom - r.bottom - 4),
        ) + "px",
    });
  }
  function close() {
    menu.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    input.value = label(selected);
  }
  function choose(code) {
    const changed = selected !== code;
    selected = code;
    close();
    if (changed) onChange(code);
  }
  function draw(query = "") {
    const q = fold(query);
    matches = options.filter((row) => row.keys.some((key) => key.includes(q)));
    const exact = matches.findIndex((row) => row.keys.includes(q));
    if (q && exact > 0) matches.unshift(matches.splice(exact, 1)[0]);
    active = -1;
    input.removeAttribute("aria-activedescendant");
    menu.replaceChildren(
      ...matches.map(({ code, text, count }, index) => {
        const row = document.createElement("div");
        row.id = menu.id + "-" + index;
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(selected === code));
        row.dataset.code = code;
        row.textContent = [
          text,
          code === "?" ? "" : code,
          count == null ? "" : "（" + count + "）",
        ]
          .filter(Boolean)
          .join(" ");
        return row;
      }),
    );
    if (!matches.length) menu.textContent = "没有匹配的国家或地区";
    menu.hidden = false;
    input.setAttribute("aria-expanded", "true");
    menu.scrollTop = 0;
    position();
  }
  input.onfocus = () => {
    input.select();
    draw();
  };
  input.onclick = () => {
    if (menu.hidden) {
      input.select();
      draw();
    }
  };
  input.oninput = () => draw(input.value);
  input.onblur = () => {
    if (menu.hidden) return;
    const query = fold(input.value);
    const exact = query && matches.find((row) => row.keys.includes(query));
    if (!query) choose("");
    else if (exact) choose(exact.code);
    else close();
  };
  input.onkeydown = (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      close();
      return;
    }
    if (event.key === "Enter" && !menu.hidden) {
      event.preventDefault();
      if (matches.length) choose(matches[Math.max(0, active)].code);
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (menu.hidden) draw();
    if (!matches.length) return;
    active =
      event.key === "ArrowDown"
        ? (active + 1) % matches.length
        : active <= 0
          ? matches.length - 1
          : active - 1;
    menu.querySelector(".highlight")?.classList.remove("highlight");
    const option = menu.children[active];
    option.classList.add("highlight");
    input.setAttribute("aria-activedescendant", option.id);
    option.scrollIntoView({ block: "nearest" });
  };
  toggle.onmousedown = menu.onmousedown = (e) => e.preventDefault();
  toggle.onclick = () => {
    if (!menu.hidden) {
      close();
      return;
    }
    input.focus();
    input.select();
    draw();
  };
  menu.onclick = (e) => {
    const row = e.target.closest("[role=option]");
    if (row) choose(row.dataset.code);
  };
  document.addEventListener("pointerdown", (e) => {
    if (
      !menu.hidden &&
      !input.parentElement.contains(e.target) &&
      !menu.contains(e.target)
    )
      input.blur();
  });
  window.addEventListener("scroll", position, true);
  window.addEventListener("resize", position);
  window.visualViewport?.addEventListener("resize", position);
  return {
    setOptions(entries, value = "") {
      options = entries
        .map(({ code, count }) => {
          const text = label(code);
          return {
            code,
            text,
            count,
            keys: [
              text,
              code,
              code === "?" ? "" : en?.of(code) || "",
              code === "GB" ? "UK" : "",
            ].map(fold),
          };
        })
        .sort(
          (a, b) =>
            Number(a.code === "?") - Number(b.code === "?") ||
            a.text.localeCompare(b.text, "zh-CN"),
        );
      options.unshift({ code: "", text: allLabel, keys: [fold(allLabel)] });
      selected = value;
      close();
    },
    setValue(code) {
      selected = code;
      close();
    },
    get value() {
      return selected;
    },
  };
}

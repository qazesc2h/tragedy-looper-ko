#!/usr/bin/env node
/**
 * ko 번역 파일 검증 · 정리 도구
 *
 *   node scripts/check-ko-translations.mjs            # 검증만
 *   node scripts/check-ko-translations.mjs --strip     # 빈 항목 제거본을 *.stripped.json 으로 출력
 *   node scripts/check-ko-translations.mjs --lang de   # 다른 언어 검사
 *
 * 검사 항목
 *   1. 스키마 enum에 없는 키   ← 아포스트로피(’ vs ')·공백·오타로 조용히 무시되는 항목을 잡는다
 *   2. 파일 간 중복 키          ← 빌드는 경고만 내고 먼저 읽은 쪽을 채택한다
 *   3. { } 플레이스홀더 누락
 *   4. :token: 누락 / 변형
 *   5. 원문에 없는 마크다운 링크 ← 있으면 런타임에 번역 전체가 폐기된다
 *
 * 전제: `npm i` 로 *.schema.json 이 생성되어 있어야 한다.
 */

import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const STRIP = args.includes('--strip');
const LANG = (() => {
  const i = args.indexOf('--lang');
  return i >= 0 && args[i + 1] ? args[i + 1] : 'ko';
})();

const ROOT = process.cwd();

/** scripts/generateTragedysSchema.ts 의 transformJsoncToJSON 과 동일한 동작 */
function stripJsonc(text) {
  let inString = false;
  let inComment = false;
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (!inComment && char === '"' && (i === 0 || text[i - 1] !== '\\')) {
      inString = !inString;
      result += char;
    } else if (!inString && char === '/' && next === '/') {
      inComment = true;
      i++;
    } else if (!inString && char === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      inComment = false;
    } else if (inComment && char === '\n') {
      inComment = false;
      result += char;
    } else if (!inComment) {
      result += char;
    }
  }
  return result;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.jsonc?$/.test(entry.name)) out.push(p);
  }
  return out;
}

// ---- 번역 파일 수집 -------------------------------------------------------
const files = [];
for (const p of walk(ROOT)) {
  let parsed;
  try {
    parsed = JSON.parse(stripJsonc(fs.readFileSync(p, 'utf-8')));
  } catch {
    continue;
  }
  if (
    parsed &&
    typeof parsed.$schema === 'string' &&
    parsed.$schema.includes('translations.schema.json') &&
    parsed.translations &&
    parsed.translations[LANG]
  ) {
    files.push({ path: p, parsed });
  }
}

if (files.length === 0) {
  console.error(`'${LANG}' 항목을 가진 번역 파일을 찾지 못했습니다.`);
  process.exit(1);
}

// ---- 검증 ----------------------------------------------------------------
const seen = new Map(); // key -> first file
let errors = 0;
let warnings = 0;
let filled = 0;
let empty = 0;

const problem = (file, key, msg) => {
  errors++;
  console.log(`  ✗ ${path.relative(ROOT, file)}\n      ${JSON.stringify(key)}\n      ${msg}`);
};

for (const { path: file, parsed } of files) {
  const dict = parsed.translations[LANG];
  const schemaPath = path.resolve(path.dirname(file), parsed.$schema);

  let allowed = null;
  if (fs.existsSync(schemaPath)) {
    try {
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
      // NOTE: 저장소 원본의 오타 'laguages' 를 그대로 따른다
      const node = schema.definitions?.laguages ?? schema.definitions?.languages;
      if (node?.propertyNames?.enum) allowed = new Set(node.propertyNames.enum);
    } catch { /* ignore */ }
  }
  if (!allowed) {
    warnings++;
    console.log(`  ! 스키마 없음: ${path.relative(ROOT, schemaPath)}  (npm i 를 먼저 실행하세요)`);
  }

  for (const [key, value] of Object.entries(dict)) {
    if (value && value.trim()) filled++; else empty++;

    // 1. 스키마 enum 대조
    if (allowed && !allowed.has(key)) {
      const near = [...allowed].find(
        (k) => k.replace(/[’']/g, "'").trim() === key.replace(/[’']/g, "'").trim()
      );
      problem(
        file,
        key,
        near
          ? `아포스트로피/공백 차이로 키가 어긋났습니다. 아래로 교체하세요.\n      → ${JSON.stringify(near)}`
          : '번역 가능한 문자열 목록에 없는 키입니다. 이 항목은 아무 효과가 없습니다.\n' +
            '      (아이콘으로 렌더링되거나, 코드에서 실제로 쓰이지 않는 문자열)'
      );
    }

    // 2. 중복
    if (seen.has(key) && seen.get(key) !== file) {
      warnings++;
      console.log(
        `  ! 중복 키 ${JSON.stringify(key.slice(0, 60))}\n      ${path.relative(ROOT, seen.get(key))} 가 우선합니다`
      );
    } else {
      seen.set(key, file);
    }

    if (!value || !value.trim()) continue;

    // 3. 플레이스홀더
    const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const a = ph(key), b = ph(value);
    if (a.join() !== b.join()) {
      problem(file, key, `플레이스홀더 불일치: 원문 {${a}} vs 번역 {${b}}`);
    }

    // 4. :token:
    const tk = (s) => [...s.matchAll(/:([a-zA-Z0-9_]+):/g)].map((m) => m[1]).sort();
    const ta = tk(key), tb = tk(value);
    if (ta.join() !== tb.join()) {
      problem(file, key, `:token: 불일치: 원문 [${ta}] vs 번역 [${tb}]`);
    }

    // 5. 마크다운 링크 (원문에 없는 링크가 있으면 런타임에 번역 전체가 폐기된다)
    const links = (s) => new Set([...s.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]));
    const extra = [...links(value)].filter((l) => !links(key).has(l));
    if (extra.length) {
      problem(file, key, `원문에 없는 링크: ${extra.join(', ')} → 번역이 통째로 폐기됩니다`);
    }
  }
}

// ---- 용어집 게이트 (--glossary) -------------------------------------------
// 게임 용어(엔티티 이름)를 채웠다면 반드시 용어집에 근거가 기록돼 있어야 한다.
// 정발 대조 없이 값이 채워지는 것을 막는 장치다.
if (args.includes('--glossary')) {
  const gPath = path.join(ROOT, 'translations', `${LANG}.GLOSSARY.md`);
  if (!fs.existsSync(gPath)) {
    console.log(`  ! 용어집이 없습니다: ${path.relative(ROOT, gPath)}`);
    warnings++;
  } else {
    const glossary = fs.readFileSync(gPath, 'utf-8');
    const entityNames = new Set();
    const TYPES = ['roles', 'incidents', 'plots', 'tragedys', 'characters', 'keywords', 'tags'];
    const scan = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { scan(p); continue; }
        if (!/\.jsonc?$/.test(e.name)) continue;
        let j;
        try { j = JSON.parse(stripJsonc(fs.readFileSync(p, 'utf-8'))); } catch { continue; }
        for (const t of TYPES) {
          if (j?.$schema?.includes?.(`${t}.schema.json`) && Array.isArray(j[t]))
            for (const el of j[t]) if (el.name) entityNames.add(el.name);
        }
      }
    };
    scan(path.join(ROOT, 'data'));

    for (const { path: file, parsed } of files) {
      for (const [key, value] of Object.entries(parsed.translations[LANG])) {
        if (!value?.trim() || !entityNames.has(key)) continue;
        if (!glossary.includes(key)) {
          problem(
            file,
            key,
            '게임 용어인데 용어집에 근거가 없습니다.\n' +
              `      ${path.relative(ROOT, gPath)} 에 정발 대조 결과와 확신도를 먼저 기록하세요.`
          );
        }
      }
    }
  }
}

console.log('');
console.log(`파일 ${files.length}개 · 키 ${filled + empty}개 (번역됨 ${filled} / 비어있음 ${empty})`);
console.log(`오류 ${errors} · 경고 ${warnings}`);

// ---- 빈 항목 제거 ---------------------------------------------------------
if (STRIP) {
  console.log('');
  for (const { path: file, parsed } of files) {
    const dict = parsed.translations[LANG];
    const kept = Object.fromEntries(
      Object.entries(dict)
        .filter(([, v]) => v && v.trim())
        .map(([k, v]) => [k, v.trim()])
        .sort(([a], [b]) => a.localeCompare(b, 'en', { sensitivity: 'base' }))
    );
    const out = {
      $schema: parsed.$schema,
      translations: { ...parsed.translations, [LANG]: kept },
    };
    const dest = file.replace(/\.jsonc?$/, '.stripped.json');
    fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
    console.log(
      `  → ${path.relative(ROOT, dest)}  (${Object.keys(kept).length}/${Object.keys(dict).length})`
    );
  }
  console.log('\n생성된 .stripped.json 을 확인 후 원본 이름으로 바꿔 커밋하세요.');
}

process.exit(errors > 0 ? 1 : 0);

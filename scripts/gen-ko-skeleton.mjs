#!/usr/bin/env node
/**
 * ko 번역 스켈레톤 생성기
 *
 *   node scripts/gen-ko-skeleton.mjs --root              # translations/ko.jsonc
 *   node scripts/gen-ko-skeleton.mjs --set midnight-circle
 *   node scripts/gen-ko-skeleton.mjs --all-sets          # data/* 전부
 *   node scripts/gen-ko-skeleton.mjs --root --lang de    # 다른 언어
 *
 * 동작
 *   - 번역 가능한 키 목록은 `npm i` 가 생성한 *.schema.json 의 enum 에서 직접 읽는다.
 *     (추출 로직을 재구현하지 않으므로 상위 저장소가 바뀌어도 자동으로 따라간다)
 *   - 세트 파일에는 루트 enum 에 없는 키만 넣는다 → 중복 키 경고가 원천 차단된다.
 *   - **기존 번역값은 항상 보존한다.** 재생성해도 작업물이 날아가지 않는다.
 *   - 기존 ja / de 번역을 주석으로 붙인다. 정발은 일본어 5th 기준이라 ja 가 가장 유용하다.
 */

import fs from 'fs';
import path from 'path';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const LANG = opt('--lang', 'ko');
const ROOT = process.cwd();

function stripJsonc(text) {
  let inString = false, inComment = false, result = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (!inComment && c === '"' && (i === 0 || text[i - 1] !== '\\')) {
      inString = !inString; result += c;
    } else if (!inString && c === '/' && n === '/') { inComment = true; i++; }
    else if (!inString && c === '/' && n === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e === -1 ? text.length : e + 1; inComment = false;
    } else if (inComment && c === '\n') { inComment = false; result += c; }
    else if (!inComment) result += c;
  }
  return result;
}

const readJsonc = (p) => {
  try { return JSON.parse(stripJsonc(fs.readFileSync(p, 'utf-8'))); }
  catch { return null; }
};

function schemaEnum(schemaPath) {
  if (!fs.existsSync(schemaPath)) {
    console.error(`스키마가 없습니다: ${path.relative(ROOT, schemaPath)}`);
    console.error('먼저 `npm i` 를 실행하세요.');
    process.exit(1);
  }
  const s = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
  // 상위 저장소의 오타 'laguages' 를 그대로 따른다
  const node = s.definitions?.laguages ?? s.definitions?.languages;
  return new Set(node?.propertyNames?.enum ?? []);
}

// ---- 기존 번역 수집 (참고 주석 + 값 보존) --------------------------------
function collect(dir, acc = {}) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { collect(p, acc); continue; }
    if (!/\.jsonc?$/.test(e.name)) continue;
    const j = readJsonc(p);
    if (!j?.$schema?.includes?.('translations.schema.json') || !j.translations) continue;
    for (const [lang, dict] of Object.entries(j.translations)) {
      acc[lang] ??= {};
      for (const [k, v] of Object.entries(dict)) if (v?.trim()) acc[lang][k] ??= v.trim();
    }
  }
  return acc;
}
const existing = collect(ROOT);

const comment = (key, indent) => {
  const parts = [];
  for (const l of ['ja', 'de']) {
    const v = existing[l]?.[key];
    if (v) {
      const t = v.replace(/\s+/g, ' ');
      parts.push(`${l}: ${t.length > 110 ? t.slice(0, 110) + '…' : t}`);
    }
  }
  return parts.length ? `${indent}// ${parts.join('  |  ')}\n` : '';
};

// ---- 엔티티 이름 → 카테고리 분류 ------------------------------------------
const TYPES = ['roles', 'incidents', 'plots', 'tragedys', 'characters', 'keywords', 'tags'];
function entityNames() {
  const out = Object.fromEntries(TYPES.map((t) => [t, new Set()]));
  const propNames = new Set(), ids = new Set();
  const walkObj = (o) => {
    if (Array.isArray(o)) o.forEach(walkObj);
    else if (o && typeof o === 'object')
      for (const [k, v] of Object.entries(o)) { propNames.add(k); walkObj(v); }
  };
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { scan(p); continue; }
      if (!/\.jsonc?$/.test(e.name)) continue;
      const j = readJsonc(p);
      if (!j?.$schema) continue;
      for (const t of TYPES) {
        if (j.$schema.includes(`${t}.schema.json`) && j[t]) {
          walkObj(j[t]);
          for (const el of j[t]) { if (el.name) out[t].add(el.name); if (el.id) ids.add(el.id); }
        }
      }
    }
  };
  scan(path.join(ROOT, 'data'));
  return { out, junk: new Set([...propNames, ...ids]) };
}

const SECTIONS = [
  ['roles', '역할 (Roles) — 정발 요약시트 대조 1순위'],
  ['incidents', '사건 (Incidents) — 정발 요약시트 대조 1순위'],
  ['plots', '플롯 (Plots / 룰 X·Y) — 정발 요약시트 대조 1순위'],
  ['tragedys', '참극 세트 (Tragedy Sets)'],
  ['characters', '캐릭터 이름 (Characters) — 정발 캐릭터 카드 대조'],
  ['keywords', '키워드 · 태그 (Keywords / Tags)'],
  ['terms', '게임 용어 · 장소 · 타이밍 (짧은 문자열)'],
  ['prose', '능력 · 효과 · 규칙 텍스트 (긴 문장) — 마지막에 작업'],
  ['scriptText', '각본 텍스트 (제목.제작자.필드)'],
];

function classify(keys, names, junk) {
  const b = Object.fromEntries(SECTIONS.map(([k]) => [k, []]));
  for (const k of keys) {
    if (junk.has(k) || /^[\d\s.,+\-/]*$/.test(k)) continue;
    if (/^.+\.[^.]+\.(title|description|story|specialRules|mastermindHints|victory-conditions)$/.test(k)) {
      b.scriptText.push(k); continue;
    }
    const hit = TYPES.find((t) => names[t]?.has(k));
    if (hit) { b[hit === 'tags' ? 'keywords' : hit].push(k); continue; }
    (k.length <= 30 && !k.endsWith('.') ? b.terms : b.prose).push(k);
  }
  return b;
}

// ---- 파일 생성 -------------------------------------------------------------
const sortKey = (a, b) => a.length - b.length || a.toLowerCase().localeCompare(b.toLowerCase());

function write(target, keys, prior, header) {
  const { out: names, junk } = entityNames();
  const buckets = classify(keys, names, junk);
  const body = [];
  let n = 0, kept = 0;

  for (const [cat, title] of SECTIONS) {
    const ks = buckets[cat].sort(sortKey);
    if (!ks.length) continue;
    body.push(`      // ==== ${title}  (${ks.length}개) ${'='.repeat(Math.max(0, 56 - title.length))}\n`);
    for (const k of ks) {
      const c = comment(k, '      ');
      if (c) body.push(c);
      const v = prior[k] ?? '';
      if (v) kept++;
      body.push(`      ${JSON.stringify(k)}: ${JSON.stringify(v)},\n`);
      n++;
    }
    body.push('\n');
  }

  let txt = body.join('').trimEnd();
  if (txt.endsWith(',')) txt = txt.slice(0, -1);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${header}    "${LANG}": {\n${txt}\n    }\n  }\n}\n`);
  console.log(`  → ${path.relative(ROOT, target)}  키 ${n}개 (기존 번역 ${kept}개 보존)`);
  return n;
}

const HEADER = (schemaRef, note) => `{
  // ---------------------------------------------------------------------------
  //  Tragedy Looper — ${LANG} 번역${note ? ` · ${note}` : ''}
  //  scripts/gen-ko-skeleton.mjs 로 생성. 재생성해도 기존 값은 보존된다.
  //
  //  - 키(왼쪽)는 수정 금지
  //  - { } 플레이스홀더와 :token: 은 그대로 보존
  //  - 원문에 없는 마크다운 링크 추가 시 번역 전체가 폐기됨
  //  - 확신 없으면 비워둘 것 (영어로 폴백된다)
  //  - // ja: 주석은 참고용. 정발은 일본어 5th 기준이라 ja 가 가장 가깝다
  // ---------------------------------------------------------------------------
  "$schema": "${schemaRef}",
  "translations": {
`;

const priorOf = (p) => readJsonc(p)?.translations?.[LANG] ?? {};

const rootEnum = schemaEnum(path.join(ROOT, 'translations', 'translations.schema.json'));

if (flag('--root')) {
  const target = path.join(ROOT, 'translations', `${LANG}.jsonc`);
  write(target, rootEnum, priorOf(target), HEADER('./translations.schema.json', 'UI + 게임 데이터'));
}

const sets = flag('--all-sets')
  ? fs.readdirSync(path.join(ROOT, 'data'), { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name)
  : opt('--set') ? [opt('--set')] : [];

for (const set of sets) {
  const dir = path.join(ROOT, 'data', set);
  const schemaPath = path.join(dir, 'translations.schema.json');
  if (!fs.existsSync(schemaPath)) { console.log(`  · ${set} 건너뜀 (스키마 없음)`); continue; }
  // 루트 enum 에 이미 있는 키는 제외 → 중복 키 경고 원천 차단
  const keys = [...schemaEnum(schemaPath)].filter((k) => !rootEnum.has(k));
  if (!keys.length) { console.log(`  · ${set} 건너뜀 (고유 키 없음)`); continue; }
  const target = path.join(dir, `translation.${LANG}.jsonc`);
  write(target, keys, priorOf(target), HEADER('./translations.schema.json', `${set} 각본`));
}

if (!flag('--root') && !sets.length) {
  console.log('사용법: --root | --set <폴더> | --all-sets  [--lang ko]');
}

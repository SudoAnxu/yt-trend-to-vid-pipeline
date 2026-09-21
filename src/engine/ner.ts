// ============================================================
// Trend Radar — Node 5: Candidate Extractor (faithful port)
// Ported from the YT Intel app engine (src/lib/engine/ner.ts),
// including every fix found by the historical replay benchmark:
//   - present-tense context verbs ("walks off", "launches")
//   - role prefixes ("Streamer Alex Nova")
//   - all-lowercase trend-topic sweep ("alex nova walks off")
//   - sentence-initial connectors ("So Jordan Vex ...")
// Differences from the app: entity records come from state.json
// (plain objects) instead of Prisma rows, and the LLM tie-breaker
// is optional (only used when LLM_API_KEY is configured).
// ============================================================

import { PERSON_PROB_FLOOR } from './config';
import type { EntityCandidate, NoveltyClass } from './types';

const STOPWORDS = new Set([
  'the', 'this', 'that', 'these', 'those', 'what', 'who', 'why', 'how', 'when', 'where',
  'is', 'are', 'was', 'were', 'be', 'been', 'am', 'do', 'does', 'did', 'has', 'have', 'had',
  'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must', 'shall',
  'and', 'or', 'but', 'if', 'then', 'than', 'so', 'because', 'as', 'of', 'at', 'by', 'for',
  'with', 'about', 'against', 'between', 'into', 'through', 'during', 'before', 'after',
  'above', 'below', 'up', 'down', 'out', 'off', 'over', 'under', 'again', 'further',
  'new', 'real', 'best', 'top', 'trending', 'video', 'official', 'full', 'part', 'episode',
  'google', 'youtube', 'reddit', 'news', 'update', 'breaking', 'watch', 'explained',
  'america', 'usa', 'uk', 'india', 'europe', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april',
  'june', 'july', 'august', 'september', 'october', 'november', 'december',
]);

const ROLE_WORDS = new Set([
  'singer', 'actor', 'actress', 'rapper', 'streamer', 'youtuber', 'creator', 'influencer',
  'ceo', 'founder', 'politician', 'athlete', 'footballer', 'producer', 'director',
  'journalist', 'host', 'comedian', 'model', 'author', 'boxer', 'fighter', 'developer',
]);

// Context verbs indicating a person is acting. Present + past: headlines
// use present ("walks off", "launches"), prose uses past ("testified").
const CONTEXT_VERBS = [
  'said', 'says', 'say', 'responded', 'responds', 'announced', 'filed', 'files',
  'dated', 'married', 'accused', 'accuses', 'denied', 'denies', 'admitted',
  'confirmed', 'testified', 'testifies', 'launched', 'launches', 'launch',
  'apologized', 'apologizes', 'posted', 'shares', 'shared', 'called', 'revealed',
  'reveals', 'claimed', 'claims', 'refused', 'signed', 'deleted', 'streamed',
  'walked', 'walks', 'exposed', 'leaked', 'sued', 'sues', 'wins', 'won', 'lost',
  'loses', 'quits', 'quit', 'joins', 'joined', 'fires', 'arrested', 'declined',
  'declines', 'defends', 'defended', 'develops', 'developed', 'founded', 'founds',
  'created', 'creates', 'withheld', 'states', 'stated',
  // Headline present-tense verbs (live RSS titles use these constantly).
  'makes', 'make', 'voiced', 'voice', 'voices', 'reacts', 'reacted', 'reveal',
  'speaks', 'spoke', 'breaks', 'broke', 'addresses', 'addressed', 'discusses',
  'discussed', 'returns', 'returned', 'earns', 'earned', 'shines', 'records',
  'recorded', 'lands', 'landed', 'pulls', 'pulled', 'sends', 'sent', 'takes',
  'took', 'gives', 'gave', 'gets', 'got', 'throws', 'threw', 'delivers',
  'delivered', 'dominates', 'passes', 'passed', 'catches', 'caught', 'scores',
  'scored', 'leads', 'led', 'hits', 'hit', 'runs', 'ran', 'drops', 'dropped',
];

/**
 * Common English first names. A capitalized run whose first token is a
 * known first name gets a modest person boost — this is what lets the
 * engine pick names up from all-lowercase search-trend topics like
 * "alex nova walks off" where no capitalization signal exists.
 */
const KNOWN_FIRST_NAMES = new Set([
  'alex', 'alexander', 'alexandra', 'alexis', 'andrew', 'anthony', 'ashley',
  'austin', 'ben', 'benjamin', 'bradley', 'brandon', 'brian', 'brittany',
  'carlos', 'chad', 'charles', 'chris', 'christopher', 'colin', 'connor',
  'daniel', 'danny', 'david', 'dennis', 'diego', 'dominic', 'dylan', 'edward',
  'eli', 'elias', 'emily', 'emma', 'eric', 'ethan', 'evan', 'felix', 'gavin',
  'grace', 'greg', 'hannah', 'harry', 'hayden', 'hugh', 'ian', 'isaac', 'jack',
  'jacob', 'jake', 'james', 'jason', 'jay', 'jeff', 'jennifer', 'jessica',
  'jill', 'jim', 'joe', 'joel', 'john', 'jonah', 'jonathan', 'jordan', 'jose',
  'josh', 'julia', 'justin', 'kara', 'kate', 'katherine', 'keith', 'kevin',
  'kyle', 'lance', 'larry', 'lauren', 'leo', 'leon', 'liam', 'logan', 'louise',
  'lucas', 'luke', 'marcus', 'mario', 'mark', 'martin', 'mason', 'matt',
  'matthew', 'maya', 'megan', 'mia', 'michael', 'michelle', 'mike', 'nathan',
  'nicholas', 'nick', 'noah', 'oliver', 'olivia', 'oscar', 'owen', 'patrick',
  'paul', 'peter', 'philip', 'rachel', 'ralph', 'randy', 'ray', 'reed', 'rex',
  'rick', 'riley', 'rob', 'robert', 'roger', 'ron', 'rose', 'roy', 'russell',
  'ryan', 'sam', 'samuel', 'scott', 'sean', 'seth', 'shane', 'sofia', 'spencer',
  'stanley', 'stephen', 'steve', 'steven', 'ted', 'terry', 'theo', 'thomas',
  'tim', 'tobias', 'todd', 'tom', 'tony', 'travis', 'trevor', 'tyler', 'victor',
  'vincent', 'wesley', 'will', 'william', 'zach', 'zack', 'zoe',
  // Second batch — live headlines use a far wider name pool than the
  // simulated benchmark did ("Angel Reese", "Howie Rose", "Jalen Hurts").
  'angel', 'andre', 'barry', 'billy', 'bobby', 'bruce', 'bryan', 'carl', 'cody',
  'curtis', 'dexter', 'don', 'donna', 'dwight', 'earl', 'eddie', 'floyd', 'gary',
  'glenn', 'gordon', 'grant', 'hank', 'harvey', 'howard', 'howie', 'irving',
  'ivan', 'jayden', 'jeffrey', 'jeremy', 'jerry', 'jesse', 'jimmy', 'joey',
  'jon', 'julie', 'kai', 'karl', 'ken', 'kenny', 'kirk', 'kristen', 'kurt',
  'landon', 'lawrence', 'lee', 'leonard', 'lewis', 'lloyd', 'louis', 'luis',
  'malik', 'marc', 'marvin', 'max', 'melissa', 'micah', 'miguel', 'milo',
  'mitchell', 'nate', 'neil', 'norman', 'pablo', 'pedro', 'preston', 'quincy',
  'rafael', 'ramon', 'randall', 'reggie', 'rene', 'ricardo', 'rita', 'rodney',
  'roland', 'rosie', 'ruben', 'rudy', 'sally', 'simon', 'stacy', 'stella',
  'sylvia', 'tanya', 'terrence', 'tiffany', 'timothy', 'tracy', 'valerie',
  'vera', 'vernon', 'walter', 'wanda', 'warren', 'wendy', 'xavier', 'zane',
]);

// Homonym penalty: common nouns / brands / places that appear as names.
const HOMONYM_COMMON = new Set([
  'apple', 'amazon', 'google', 'meta', 'netflix', 'tesla', 'nvidia', 'openai', 'microsoft',
  'sky', 'storm', 'river', 'wolf', 'angel', 'queen', 'king', 'prince', 'ghost', 'shadow',
  'star', 'dream', 'legend', 'prime', 'rocket', 'diamond', 'cash', 'money', 'gold',
]);

/** Tokens like "JR", "III", "PhD" that glue names together. */
const NAME_SUFFIXES = new Set(['jr', 'jr.', 'iii', 'iv', 'phd', 'md', 'dds']);

/**
 * Words that mark a capitalized run as a publication/company/segment
 * boundary rather than a person ("The Verge", "Hollywood Reporter",
 * "... Fox What is going on ...").
 */
const NOT_A_PERSON = new Set([
  'the', 'this', 'that', 'what', 'why', 'how', 'who', 'when', 'where', 'breaking',
  'watch', 'official', 'video', 'exclusive', 'report', 'reports', 'sources', 'source',
  'insider', 'update', 'claims', 'alleged', 'leaked', 'inside', 'everything', 'top',
  'verge', 'reporter', 'reporters', 'herald', 'times', 'post', 'daily', 'news',
  'journal', 'chronicle', 'magazine', 'buzzfeed', 'variety', 'bloomberg', 'reuters',
  'deadline', 'forbes', 'wired', 'press', 'media', 'outlet', 'outlets', 'channel',
  'street', 'wall', 'associated', 'today', 'tonight', 'week', 'month', 'year', 'live',
  // Sports franchises are classic person-name homonyms ("Jose Sharks",
  // "Sunday Mets") — franchise nicknames and calendar words.
  'sharks', 'mets', 'yankees', 'sox', 'lakers', 'cowboys', 'eagles', 'jaguars',
  'panthers', 'rangers', 'bruins', 'cubs', 'bears', 'packers', 'seahawks',
  'dolphins', 'jets', 'chiefs', 'raiders', 'chargers', 'vikings', 'lions',
  'falcons', 'saints', 'buccaneers', 'cardinals', 'rams', 'heat', 'magic',
  'braves', 'astros', 'dodgers', 'phillies', 'orioles', 'guardians', 'royals',
  'twins', 'rays', 'mariners', 'padres', 'giants', 'rockies', 'brewers',
  'pirates', 'reds', 'jays', 'niners', 'bengals', 'browns', 'steelers',
  'ravens', 'bills', 'patriots', 'broncos', 'texans', 'titans', 'colts',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'june', 'july', 'august',
  'september', 'october', 'november', 'december', 'somehow', 'anyone',
  // Brands / platforms that show up in Title Case headlines.
  'reebok', 'nike', 'adidas', 'espn', 'hulu', 'disney', 'boeing', 'starbucks',
  'pepsi', 'verizon', 'comcast', 'sony', 'xbox', 'playstation', 'nintendo',
  'spotify', 'twitch', 'tiktok', 'instagram', 'facebook', 'twitter',
  'snapchat', 'discord', 'walmart', 'target', 'ebay', 'shopify', 'roblox',
  // Headline furniture words that Title-Case into fragments
  // ("North Preview", "Latest Updates", "Game Discussion").
  'not', 'preview', 'previews', 'updates', 'update', 'picks', 'discussion',
  'column', 'blog', 'game', 'games', 'week', 'north', 'south', 'east', 'west',
  'latest', 'staff', 'center', 'ducks', 'bay', 'honda', 'vs', 'report',
  'analysis', 'recap', 'grades', 'takeaways', 'highlights', 'injury',
  'injuries', 'power', 'rankings', 'odds', 'schedule', 'roster', 'depth',
  // Sentence-initial connectors that fuse into a following name.
  'so', 'also', 'then', 'now', 'still', 'even', 'just', 'again',
]);

const GENERIC_TOPIC_WORDS = new Set([
  'wake-up', 'call', 'alarm', 'warning', 'hot', 'women', 'history', 'campaign', 'awareness', 'detection', 'journey', 'reaction', 'place', 'expected', 'involves', 'more', 'than', 'update', 'updates', 'breaking', 'news', 'story',
  'stories', 'trend', 'trending', 'controversy', 'drama', 'scandal', 'reaction', 'reactions',
  'review', 'reviews', 'trailer', 'trailers', 'episode', 'season', 'finale', 'premiere',
  'game', 'games', 'match', 'matches', 'score', 'scores', 'win', 'wins', 'loss', 'losses',
  'report', 'reports', 'video', 'videos', 'movie', 'movies', 'song', 'songs', 'album', 'albums',
  'concert', 'concerts', 'tour', 'tours', 'festival', 'festivals', 'event', 'events',
  'launch', 'launches', 'release', 'releases', 'announcement', 'announcements',
  'fight', 'fights', 'fight-night', 'interview', 'interviews', 'podcast', 'podcasts',
  'challenge', 'challenges', 'moment', 'moments', 'reaction', 'responds', 'response',
  'crisis', 'problem', 'problems', 'mystery', 'mysteries', 'truth', 'inside', 'exclusive',
  'leak', 'leaks', 'leaked', 'exposed', 'exposure', 'statement', 'statements',
]);

const KNOWN_PERSON_ROLES_SUFFIX = /\b(singer|actor|rapper|streamer|youtuber|creator|ceo|founder|politician|athlete|producer|director|journalist|host|comedian|model|author|boxer|fighter)\b/i;

// ------------------------------------------------------------
// NER / name extraction
// ------------------------------------------------------------

export function extractNameCandidates(text: string): EntityCandidate[] {
  const clean = text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    // Punctuation is segmentation evidence in Title Case headlines:
    // "Not Satisfied": Angel Reese -> two segments. Keep apostrophes
    // (possessives) and hyphens (name parts) inside tokens.
    .replace(/[^A-Za-z0-9\s'\-\.]/g, ' , ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return [];

  const lower = clean.toLowerCase();
  const candidates = new Map<string, EntityCandidate>();

  // Sentence-ish chunks: sentence enders, commas/quotes (inserted above),
  // and em-dashes. Capitalized words never fuse across these boundaries.
  const sentences = clean.split(/(?<=[.!?])\s+|,\s+|\s+,\s+|\s+[—-]\s+/);

  for (const sentence of sentences) {
    const words = sentence.split(' ').filter(Boolean);
    let i = 0;
    while (i < words.length) {
      const t = words[i];
      const isCap = /^[A-Z][a-z'\-]{1,}$/.test(t);
      if (!isCap) {
        i++;
        continue;
      }
      const run: string[] = [t];
      let j = i + 1;
      while (j < words.length && run.length < 4) {
        const n = words[j];
        if (/^[A-Z][a-z'\-]{1,}$/.test(n)) {
          run.push(n);
          j++;
        } else if (NAME_SUFFIXES.has(n.toLowerCase())) {
          run.push(n);
          j++;
        } else {
          break;
        }
      }
      // Role prefix describes the person, it is not part of the name —
      // emitting both would create duplicate entities.
      const rolePrefix = run.length >= 2 && ROLE_WORDS.has(run[0].toLowerCase());
      const startIdx = rolePrefix ? 1 : 0;
      const variants: { name: string; atRunStart: boolean; runLen: number }[] = [];
      for (let size = Math.min(run.length - startIdx, 3); size >= 2; size--) {
        for (let start = startIdx; start + size <= run.length; start++) {
          variants.push({
            name: run.slice(start, start + size).join(' '),
            atRunStart: start === startIdx,
            runLen: run.length - startIdx,
          });
        }
      }
      if (!rolePrefix && run.length === 1) {
        variants.push({ name: run[0], atRunStart: true, runLen: 1 });
      }

      for (const v of variants) {
        if (candidates.has(v.name)) continue;
        const parts = v.name.toLowerCase().split(' ').map((p) => p.replace(/[’']s$/i, ''));
        if (NOT_A_PERSON.has(parts[0]) || NOT_A_PERSON.has(parts[parts.length - 1])) continue;
        // Names neither start nor end with verbs — kills Title Case
        // fusions like "Voices Discontent" / "Reese Makes".
        if (CONTEXT_VERBS.includes(parts[0]) || CONTEXT_VERBS.includes(parts[parts.length - 1])) continue;
        // Window acceptance: a clean bounded 2-token run (First Last), or
        // a window anchored by a known first name. Interior fusions like
        // "Milestone During" / "During Dream" are rejected.
        const knownFirst = KNOWN_FIRST_NAMES.has(parts[0]);
        const cleanPair = v.runLen === 2 && v.atRunStart;
        const hasRoleOrVerb = CONTEXT_VERBS.some((verb) => parts.includes(verb)) ||
          ROLE_WORDS.has(parts[0]) || ROLE_WORDS.has(parts[parts.length - 1]);
        const genericPair = parts.length >= 2 && parts.some((p) => GENERIC_TOPIC_WORDS.has(p));
        // A bounded Title-Case pair alone is not enough: trend topics,
        // headlines, song/movie titles and phrases such as "Wake-up Call"
        // frequently look exactly like First Last. Preserve unknown-person
        // discovery when a known first name, role, or person-action verb
        // provides independent evidence.
        if (genericPair && !knownFirst && !hasRoleOrVerb) continue;
        if (parts.length >= 3 && !hasRoleOrVerb) continue;
        // An unknown Title-Case pair is not enough to establish a person:
        // entertainment titles, places, products, and phrases routinely
        // look like "First Last" (e.g. Silent Hill, New York). Require
        // either a known first name or explicit person/action context.
        if (!knownFirst && !hasRoleOrVerb && v.runLen !== 1) continue;
        if (!cleanPair && !knownFirst && !hasRoleOrVerb && v.runLen !== 1) continue;
        // Possessive headline fragments such as "Brian's Fall" are topic
        // phrases, not reliable person names. Keep normal O'Name forms.
        if (/'s$/i.test(v.name.split(' ')[0])) continue;
        const prob = personLikelihood(v.name, sentence, lower);
        candidates.set(v.name, { name: v.name, ...prob });
      }

      i = j > i ? j : i + 1;
    }
  }

  const ranked = [...candidates.values()]
    .filter((c) => c.personProb >= PERSON_PROB_FLOOR)
    .sort((a, b) => b.personProb - a.personProb);

  // All-lowercase texts (Google Trends topic strings are often fully
  // lowercase) never enter the capitalized-run scan. Sweep for
  // (known first name + surname-like token) bigrams.
  if (clean === clean.toLowerCase() && /\d/.test(clean) === false) {
    const words = clean.split(' ');
    for (let i = 0; i < words.length - 1; i++) {
      const w1 = words[i];
      const w2 = words[i + 1];
      if (!KNOWN_FIRST_NAMES.has(w1)) continue;
      if (w2.length < 3) continue;
      if (STOPWORDS.has(w2) || NOT_A_PERSON.has(w2) || HOMONYM_COMMON.has(w2)) continue;
      if (CONTEXT_VERBS.includes(w2) || ROLE_WORDS.has(w2)) continue;
      const name = `${w1[0].toUpperCase()}${w1.slice(1)} ${w2[0].toUpperCase()}${w2.slice(1)}`.replace(/[’']s\b/gi, '');
      if (candidates.has(name)) continue;
      const prob = personLikelihood(name, clean, lower);
      candidates.set(name, { name, ...prob });
      if (prob.personProb >= PERSON_PROB_FLOOR) ranked.push({ name, ...prob });
    }
    ranked.sort((a, b) => b.personProb - a.personProb);
  }

  return ranked;
}

interface LikelihoodParts {
  personProb: number;
  contextVerbsHit: string[];
  roleContextHit: string | null;
  homonymPenalty: number;
}

function personLikelihood(name: string, _fullText: string, lowerText: string): LikelihoodParts {
  const tokens = name.split(' ');
  const lowerName = name.toLowerCase();

  // Base raised so a clean First-Last run (the dominant real-news shape)
  // clears the 0.75 floor on structure alone — replay benchmarks with a
  // narrow name vocabulary hid this recall gap.
  let prob = 0.5;
  let homonymPenalty = 0;

  if (tokens.length === 2) prob += 0.25;
  else if (tokens.length === 3) prob += 0.25;
  else prob += 0.05;

  const normText = lowerText.replace(/\s+/g, ' ');
  const normNameRe = new RegExp(`\\b${escapeRe(lowerName)}\\b`);
  const verbsHit = CONTEXT_VERBS.filter((v) => {
    const vRe = new RegExp(`\\b${v}\\b`);
    if (!vRe.test(normText)) return false;
    const idx = normText.search(normNameRe);
    if (idx < 0) return false;
    return normText.slice(Math.max(0, idx - 90), idx + name.length + 120).match(vRe) !== null;
  });
  if (verbsHit.length > 0) prob += Math.min(0.24, 0.12 * verbsHit.length);

  let roleHit: string | null = null;
  const nameIdx = lowerText.search(normNameRe);
  const roleWindow = nameIdx >= 0
    ? lowerText.slice(Math.max(0, nameIdx - 30), nameIdx + name.length + 80)
    : '';
  for (const role of ROLE_WORDS) {
    const re = new RegExp(`\\b${role}s?\\b`, 'i');
    if (re.test(roleWindow)) {
      roleHit = role;
      break;
    }
  }
  if (roleHit) prob += 0.15;
  if (KNOWN_PERSON_ROLES_SUFFIX.test(lowerText)) prob += 0.05;

  if (HOMONYM_COMMON.has(lowerName)) homonymPenalty += 0.35;
  const first = tokens[0].toLowerCase();
  const last = tokens[tokens.length - 1].toLowerCase();
  if (first === last) homonymPenalty += 0.15;
  if (tokens.length === 1 && HOMONYM_COMMON.has(first)) homonymPenalty = Math.max(homonymPenalty, 0.35);
  if (/\b(gpt|ai|labs?|inc|corp|llc|ltd)\b/i.test(name) && tokens.length > 1) homonymPenalty += 0.3;

  prob -= homonymPenalty;
  if (KNOWN_FIRST_NAMES.has(first)) prob += 0.12;

  return {
    personProb: clamp01(prob),
    contextVerbsHit: verbsHit,
    roleContextHit: roleHit,
    homonymPenalty: clamp01(homonymPenalty),
  };
}

// ------------------------------------------------------------
// Alias expansion
// ------------------------------------------------------------

export function expandAliases(name: string): string[] {
  const base = name.trim();
  const aliases = new Set<string>();
  aliases.add(base);
  const parts = base.split(/\s+/);
  if (parts.length === 2) {
    const [first, last] = parts;
    aliases.add(`${first[0]}. ${last}`);
    aliases.add(`${first} ${last[0]}.`);
    const nick: Record<string, string> = {
      michael: 'Mike', robert: 'Rob', william: 'Bill', james: 'Jim',
      richard: 'Rick', joseph: 'Joe', charles: 'Chuck', thomas: 'Tom',
      christopher: 'Chris', daniel: 'Dan', matthew: 'Matt', anthony: 'Tony',
      alex: 'Alexander', alexander: 'Alex', alexis: 'Alex',
      chris: 'Christopher', tom: 'Thomas', ben: 'Benjamin', benjamin: 'Ben',
      sam: 'Samuel', samuel: 'Sam', katherine: 'Kate', kate: 'Katherine',
      jennifer: 'Jen', jen: 'Jennifer', liz: 'Elizabeth', elizabeth: 'Liz',
    };
    const fn = first.toLowerCase();
    if (nick[fn]) {
      aliases.add(`${nick[fn]} ${last}`);
      if (nick[last.toLowerCase()]) aliases.add(`${first} ${nick[last.toLowerCase()]}`);
    }
  }
  if (base.includes('.')) aliases.add(base.replace(/\./g, ''));
  if (base.includes('-')) {
    aliases.add(base.replace(/-/g, ' '));
    aliases.add(base.replace(/-/g, ''));
  }
  if (base.includes("'")) aliases.add(base.replace(/'/g, ''));
  return [...aliases].filter(Boolean);
}

// ------------------------------------------------------------
// Entity resolution (state.json-backed; deterministic, LLM optional)
// ------------------------------------------------------------

export interface StateEntity {
  key: string;
  canonicalName: string;
  aliases: string[];
  type: string;
  confidence: number;
  firstSeen: string;
  lastSeen: string;
  mentionCount: number;
  momentumHistory: number[];
  baselineVolume: number;
  lastSources: string[];
  status: string;
}

export function resolveDeterministic(
  candidate: EntityCandidate,
  existing: StateEntity[]
): { matched: StateEntity | null; method: 'exact' | 'alias' | 'new'; confidence: number } {
  const nameLower = candidate.name.toLowerCase().trim();

  const exact = existing.find((e) => e.canonicalName.toLowerCase().trim() === nameLower);
  if (exact) return { matched: exact, method: 'exact', confidence: 0.98 };

  for (const e of existing) {
    if (e.aliases.some((a) => a.toLowerCase().trim() === nameLower)) {
      return { matched: e, method: 'alias', confidence: 0.92 };
    }
  }

  const homonymRisk = candidate.homonymPenalty > 0.2;
  return { matched: null, method: 'new', confidence: homonymRisk ? 0.62 : 0.9 };
}

// ------------------------------------------------------------
// Novelty classification
// ------------------------------------------------------------

export function classifyNovelty(
  existing: { mentionCount: number; lastSeen: string; status: string } | null,
  recentVideoCount: number
): { novelty: NoveltyClass; reason: string } {
  if (!existing) {
    return { novelty: 'NEW', reason: 'never seen in the entity graph' };
  }
  const quietDays = (Date.now() - new Date(existing.lastSeen).getTime()) / 86_400_000;
  if (existing.mentionCount > 0 && quietDays > 30) {
    return { novelty: 'REACTIVATED', reason: `known person + new event after ${Math.round(quietDays)}d quiet` };
  }
  if (recentVideoCount > 15) {
    return { novelty: 'SATURATED', reason: 'many recent videos already cover the event' };
  }
  return { novelty: 'KNOWN', reason: 'known person, active monitoring' };
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export const WORD_POOL = [
  "alpha",
  "atlas",
  "aurora",
  "bandit",
  "beacon",
  "blizzard",
  "comet",
  "coyote",
  "delta",
  "echo",
  "falcon",
  "ghost",
  "glacier",
  "havoc",
  "helix",
  "ion",
  "javelin",
  "lancer",
  "mako",
  "maverick",
  "nova",
  "onyx",
  "orbit",
  "phantom",
  "ranger",
  "rogue",
  "sentinel",
  "shadow",
  "summit",
  "tempest",
  "vanguard",
  "vector",
  "vertex",
  "warden",
  "zephyr",
];

export function pickUnusedWord(usedWords) {
  const availableWords = WORD_POOL.filter((word) => !usedWords.has(word));
  if (availableWords.length === 0) {
    throw new Error("No session codes are available.");
  }

  const randomIndex = Math.floor(Math.random() * availableWords.length);
  return availableWords[randomIndex];
}

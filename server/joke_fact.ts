import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';

const DATA_DIR = path.join(process.cwd(), 'data');
const JOKES_FILE = path.join(DATA_DIR, 'jokes_cache.json');
const FACTS_FILE = path.join(DATA_DIR, 'facts_cache.json');

// Interface declarations
export interface Joke {
  setup: string;
  punchline: string;
  explanation: string;
  category: string;
}

export interface Fact {
  fact: string;
  explanation: string;
  topic: string;
}

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Rich Base Offline Databases
const BASE_JOKES: Joke[] = [
  {
    category: 'Programming',
    setup: "Why don't programmers like nature?",
    punchline: "Because it has too many bugs!",
    explanation: "This joke plays on the word 'bugs'. In programming, a 'bug' is an error or flaw in software, whereas in nature, 'bugs' refer to insects."
  },
  {
    category: 'Programming',
    setup: "How many programmers does it take to change a light bulb?",
    punchline: "None, that's a hardware problem!",
    explanation: "Programmers deal exclusively with software, so they jokingly blame physical issues (hardware) to avoid non-coding tasks."
  },
  {
    category: 'Programming',
    setup: "What is a programmer's favorite hangout place?",
    punchline: "The Foo Bar!",
    explanation: "In programming, 'foo' and 'bar' are classic placeholder names used in sample code and tutorials worldwide."
  },
  {
    category: 'Technology',
    setup: "Why did the computer go to the hospital?",
    punchline: "Because it had a virus!",
    explanation: "This plays on the double meaning of 'virus'. Computers can get infected with malicious digital programs, while humans get sick from biological viruses."
  },
  {
    category: 'Technology',
    setup: "Why was the cell phone wearing glasses?",
    punchline: "Because it lost its contacts!",
    explanation: "A clever pun on 'contacts'. Mobile phones store digital address book contacts, while humans wear contact lenses to see clearly."
  },
  {
    category: 'School',
    setup: "Why did the math book look so sad?",
    punchline: "Because it had too many problems!",
    explanation: "A math book contains mathematical 'problems' to solve, but 'problems' also refers to personal worries and difficulties."
  },
  {
    category: 'School',
    setup: "What did the paper say to the pencil?",
    punchline: "Write on!",
    explanation: "A fun play on words where the pencil literally writes 'on' the paper, and the phrase 'write on' sounds like the supportive slang 'right on!'"
  },
  {
    category: 'Animals',
    setup: "What do you call a sleeping dinosaur?",
    punchline: "A dino-snore!",
    explanation: "A simple, delightful blend of the words 'dinosaur' and 'snore' (the sound made when sleeping deeply)."
  },
  {
    category: 'Animals',
    setup: "Why do cows wear bells around their necks?",
    punchline: "Because their horns don't work!",
    explanation: "Cows have physical horns on their heads, but the joke refers to acoustic 'horns' (like car horns) that make sound, which is why they need bells."
  },
  {
    category: 'Dad jokes',
    setup: "Why did the scarecrow win an award?",
    punchline: "Because he was outstanding in his field!",
    explanation: "A double meaning: 'outstanding' means doing exceptional work, but a physical scarecrow literally stands 'out' in a farming field all day."
  },
  {
    category: 'Dad jokes',
    setup: "What do you call a factory that makes okay products?",
    punchline: "A satisfactory!",
    explanation: "A clever portmanteau blending 'satisfactory' (meaning decent or okay quality) and 'factory' (where products are manufactured)."
  },
  {
    category: 'Science',
    setup: "Why can't you trust atoms?",
    punchline: "Because they make up everything!",
    explanation: "Atoms are the tiny building blocks that physically constitute ('make up') all matter, but 'making up' also means telling fabrications and lies."
  },
  {
    category: 'Science',
    setup: "What did the physical chemist say when they were feeling down?",
    punchline: "I have low potential energy!",
    explanation: "In science, lower potential energy represents stability, but colloquially, low energy indicates tiredness or sadness."
  },
  {
    category: 'Daily life',
    setup: "Why did the bicycle collapse?",
    punchline: "Because it was two-tired!",
    explanation: "A pun on 'two-tired'. Bicycles naturally have two rubber tires, which sounds identical to being 'too tired' (exhausted)."
  },
  {
    category: 'Daily life',
    setup: "Why did the clock get sent to the principal's office?",
    punchline: "Because it was always tocking!",
    explanation: "A school-themed pun playing on the ticking and 'tocking' sound of clocks, which sounds like 'talking' during class."
  },
  {
    category: 'Funny',
    setup: "What did one plate say to another?",
    punchline: "Lunch is on me!",
    explanation: "Food and lunch are physically served 'on' plates, which sounds like the generous phrase indicating someone is paying for the meal."
  },
  {
    category: 'Clean memes',
    setup: "Why do programmers prefer dark mode?",
    punchline: "Because light attracts bugs!",
    explanation: "Programmers love coding in dark themes, and since physical lights attract insect bugs, they joke that light screens attract software bugs too."
  },
  {
    category: 'Random humor',
    setup: "What do you call a fake noodle?",
    punchline: "An impasta!",
    explanation: "A fun pun combining 'pasta' (the noodle) and 'impostor' (someone pretending to be someone else)."
  }
];

const BASE_FACTS: Fact[] = [
  {
    topic: 'Animals',
    fact: "Octopuses have three hearts.",
    explanation: "Two hearts pump blood exclusively to the gills to gather oxygen, while the third pumps it to the rest of the body. When an octopus swims, the main heart stops beating, which is why they prefer crawling."
  },
  {
    topic: 'Space',
    fact: "One day on Venus is longer than one whole year on Venus.",
    explanation: "Venus rotates on its axis extremely slowly, taking 243 Earth days for a single spin. However, it only takes Venus 225 Earth days to complete one orbit around the Sun."
  },
  {
    topic: 'Space',
    fact: "Space is completely silent.",
    explanation: "Sound waves require a physical medium like air or water to travel through. Because space is a near-perfect vacuum, there is no atmosphere to carry sound waves, resulting in total silence."
  },
  {
    topic: 'Science',
    fact: "Bananas are slightly radioactive.",
    explanation: "Bananas are rich in potassium, and a tiny fraction of natural potassium is radioactive potassium-40. However, the radiation is harmless—you would need to eat millions of bananas at once for it to affect you."
  },
  {
    topic: 'Science',
    fact: "Water can boil and freeze at the exact same time.",
    explanation: "This phenomenon is called the 'triple point'. It occurs when temperature and pressure conditions are perfect for the liquid, solid, and gas phases of a substance to exist in stable equilibrium."
  },
  {
    topic: 'Technology',
    fact: "The first computer bug was a real physical moth.",
    explanation: "In 1947, computer pioneer Grace Hopper found a physical moth trapped inside a relay of the Harvard Mark II computer. She taped it to her logbook, coining the terms 'bug' and 'debugging'."
  },
  {
    topic: 'Nature',
    fact: "Honey never spoils.",
    explanation: "Archaeologists have discovered pots of honey in ancient Egyptian tombs that are over 3,000 years old and still perfectly edible! Honey's low moisture, high acidity, and hydrogen peroxide content make it impossible for bacteria to grow."
  },
  {
    topic: 'Nature',
    fact: "Trees can communicate and share nutrients through an underground network.",
    explanation: "Using a symbiotic network of fungal threads (mycorrhizal networks) often called the 'Wood Wide Web', trees can warn neighboring trees of pests, share water, and feed dying neighbors."
  },
  {
    topic: 'Human body',
    fact: "Your stomach produces a completely new lining every few days.",
    explanation: "The digestive acids in your stomach are strong enough to dissolve metal. To prevent the stomach from digesting itself, it must constantly secrete a fresh mucus lining to protect its walls."
  },
  {
    topic: 'Human body',
    fact: "The human brain operates on about 12 to 20 watts of electrical power.",
    explanation: "Despite its immense computing capability, the human brain runs on extremely low energy—roughly enough power to light up a dim LED light bulb."
  },
  {
    topic: 'History',
    fact: "Before alarm clocks existed, there were professional 'knocker-ups'.",
    explanation: "During the Industrial Revolution in Britain, people called knocker-ups were hired to wake workers up by shooting peas or tapping on their windows with long bamboo poles."
  },
  {
    topic: 'Countries',
    fact: "Canada has more lakes than the rest of the world combined.",
    explanation: "Canada contains approximately 60% of the world's lakes. About 9% of the country's total surface area is covered by fresh water, spanning over 2 million lakes."
  },
  {
    topic: 'Oceans',
    fact: "Over 80% of the Earth's oceans remain completely unexplored.",
    explanation: "Due to the extreme depths, pitch darkness, freezing temperatures, and immense pressure, we have mapped more of the surfaces of Mars and the Moon than we have of our own ocean floor."
  },
  {
    topic: 'Psychology',
    fact: "Chewing gum while studying and then chewing the same flavor during an exam can help you remember.",
    explanation: "This is known as context-dependent memory. Sensory cues (like a specific food flavor or scent) get associated with learned information, making retrieval easier in matching contexts."
  },
  {
    topic: 'Mathematics',
    fact: "If you shuffle a standard deck of cards thoroughly, that exact order has likely never existed in history.",
    explanation: "The total number of unique ways to arrange 52 cards is 52 factorial (52!). This is a astronomically large 68-digit number, far exceeding the total number of atoms on Earth."
  },
  {
    topic: 'Computers',
    fact: "The QWERTY keyboard layout was designed to slow down typists.",
    explanation: "Early mechanical typewriters would easily jam if neighboring keys were pressed in rapid succession. The QWERTY layout was engineered to separate common letter pairings to prevent jams."
  },
  {
    topic: 'Everyday life',
    fact: "The smell of freshly cut grass is actually a distress signal.",
    explanation: "When grass is cut or damaged, it releases organic chemical compounds called Green Leaf Volatiles (GLVs). This distinctive aroma acts as a chemical warning to neighboring plants and recruits helpful predatory insects."
  }
];

// In-Memory cache of all jokes/facts loaded
let currentJokes: Joke[] = [];
let currentFacts: Fact[] = [];

// Track recently sent jokes and facts to avoid duplicates per chat JID / user JID
const recentJokesCache = new Map<string, string[]>(); // key: chatJid/user, value: list of setup strings
const recentFactsCache = new Map<string, string[]>(); // key: chatJid/user, value: list of fact strings

// Load Cache from Disk or seed defaults
export function initJokeFactCache() {
  try {
    if (fs.existsSync(JOKES_FILE)) {
      const data = fs.readFileSync(JOKES_FILE, 'utf-8');
      currentJokes = JSON.parse(data || '[]');
    }
    if (currentJokes.length === 0) {
      currentJokes = [...BASE_JOKES];
      fs.writeFileSync(JOKES_FILE, JSON.stringify(currentJokes, null, 2));
    }
  } catch (err) {
    console.error('Failed to load jokes cache, using defaults:', err);
    currentJokes = [...BASE_JOKES];
  }

  try {
    if (fs.existsSync(FACTS_FILE)) {
      const data = fs.readFileSync(FACTS_FILE, 'utf-8');
      currentFacts = JSON.parse(data || '[]');
    }
    if (currentFacts.length === 0) {
      currentFacts = [...BASE_FACTS];
      fs.writeFileSync(FACTS_FILE, JSON.stringify(currentFacts, null, 2));
    }
  } catch (err) {
    console.error('Failed to load facts cache, using defaults:', err);
    currentFacts = [...BASE_FACTS];
  }

  console.log(`[JokeFact] Initialized with ${currentJokes.length} jokes and ${currentFacts.length} facts in local cache.`);
}

// Save dynamic additions to disk
function saveJokesToDisk() {
  try {
    fs.writeFileSync(JOKES_FILE, JSON.stringify(currentJokes, null, 2));
  } catch (err) {
    console.error('Failed to save jokes cache to disk:', err);
  }
}

function saveFactsToDisk() {
  try {
    fs.writeFileSync(FACTS_FILE, JSON.stringify(currentFacts, null, 2));
  } catch (err) {
    console.error('Failed to save facts cache to disk:', err);
  }
}

// Safely initializes Gemini client if API key is present
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || apiKey.trim() === '') {
    return null;
  }
  try {
    return new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
  } catch (err) {
    console.error('[Gemini] Error initializing GoogleGenAI:', err);
    return null;
  }
}

// Track and update recent history to avoid consecutive duplicates and keep unique
function addToRecentJokes(key: string, jokeSetup: string) {
  let list = recentJokesCache.get(key) || [];
  list.push(jokeSetup);
  if (list.length > 15) {
    list.shift(); // Keep last 15
  }
  recentJokesCache.set(key, list);
}

function addToRecentFacts(key: string, factStr: string) {
  let list = recentFactsCache.get(key) || [];
  list.push(factStr);
  if (list.length > 15) {
    list.shift(); // Keep last 15
  }
  recentFactsCache.set(key, list);
}

function isRecentJoke(key: string, jokeSetup: string): boolean {
  const list = recentJokesCache.get(key) || [];
  return list.includes(jokeSetup);
}

function isRecentFact(key: string, factStr: boolean): boolean {
  const list = recentFactsCache.get(key) || [];
  return list.includes(factStr as any);
}

// Category List
export const JOKE_CATEGORIES = [
  'Funny', 'Programming', 'Technology', 'School', 'Animals',
  'Dad jokes', 'Science', 'Daily life', 'Clean memes', 'Random humor'
];

// Topic List
export const FACT_TOPICS = [
  'Space', 'Science', 'Technology', 'Nature', 'Animals', 'Human body',
  'History', 'Countries', 'Oceans', 'Psychology', 'Mathematics', 'Computers', 'Everyday life'
];

/**
 * Fetch a random joke. Uses Gemini API first, falls back to offline DB.
 */
export async function getJoke(userKey: string, categoryPreference?: string): Promise<Joke> {
  // Normalize and validate category
  let category = JOKE_CATEGORIES[Math.floor(Math.random() * JOKE_CATEGORIES.length)];
  if (categoryPreference) {
    const matched = JOKE_CATEGORIES.find(
      cat => cat.toLowerCase() === categoryPreference.toLowerCase()
    );
    if (matched) {
      category = matched;
    }
  }

  const ai = getGeminiClient();
  if (ai) {
    console.log(`[JokeFact] Attempting to generate Joke with Gemini API for category: ${category}`);
    try {
      // Prompt for Gemini
      const prompt = `Generate a random, fresh, family-friendly joke in the category: "${category}". 
The joke must be funny, safe for school and children, and follow the requested category.
Return the joke strictly as a JSON object containing "setup", "punchline", and "explanation" (an educational or entertaining explanation of why the joke is funny).`;

      const modelsToTry = ['gemini-3.6-flash', 'gemini-flash-latest'];
      let responseText: string | undefined;

      for (const modelName of modelsToTry) {
        try {
          const response = await ai.models.generateContent({
            model: modelName,
            contents: prompt,
            config: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: 'OBJECT',
                properties: {
                  setup: { type: 'STRING' },
                  punchline: { type: 'STRING' },
                  explanation: { type: 'STRING' }
                },
                required: ['setup', 'punchline', 'explanation']
              }
            }
          });
          responseText = response.text;
          if (responseText) break;
        } catch (modelErr) {
          console.warn(`[JokeFact] Joke generation failed with model ${modelName}, trying fallback...`);
        }
      }
      if (responseText) {
        const parsed: any = JSON.parse(responseText);
        if (parsed.setup && parsed.punchline && parsed.explanation) {
          const generatedJoke: Joke = {
            category,
            setup: parsed.setup.trim(),
            punchline: parsed.punchline.trim(),
            explanation: parsed.explanation.trim()
          };

          // Check if this newly generated joke is a duplicate in user's recent history
          if (!isRecentJoke(userKey, generatedJoke.setup)) {
            // Expand our offline database over time!
            const existsInCache = currentJokes.some(
              j => j.setup.toLowerCase() === generatedJoke.setup.toLowerCase()
            );
            if (!existsInCache) {
              currentJokes.push(generatedJoke);
              saveJokesToDisk();
            }

            addToRecentJokes(userKey, generatedJoke.setup);
            return generatedJoke;
          }
          console.log('[JokeFact] Generated joke was recently seen, falling back to offline/cache.');
        }
      }
    } catch (err) {
      console.error('[JokeFact] Gemini API joke generation failed, falling back to local database:', err);
    }
  }

  // FALLBACK TO OFFLINE / CACHED DATABASE
  console.log(`[JokeFact] Serving offline fallback joke for category: ${category}`);
  
  // Filter cache by requested category
  let available = currentJokes.filter(
    j => j.category.toLowerCase() === category.toLowerCase()
  );

  // If no jokes exist for this specific category in cache, use any category
  if (available.length === 0) {
    available = currentJokes;
  }

  // Try to find one that wasn't recently sent
  let selected = available.find(j => !isRecentJoke(userKey, j.setup));
  
  // Ultimate fallback if all were recently sent
  if (!selected) {
    selected = available[Math.floor(Math.random() * available.length)];
  }

  if (selected) {
    addToRecentJokes(userKey, selected.setup);
    return selected;
  }

  // Absolute fallback
  return BASE_JOKES[0];
}

/**
 * Fetch a random interesting fact. Uses Gemini API first, falls back to offline DB.
 */
export async function getFact(userKey: string, topicPreference?: string): Promise<Fact> {
  // Normalize and validate topic
  let topic = FACT_TOPICS[Math.floor(Math.random() * FACT_TOPICS.length)];
  if (topicPreference) {
    const matched = FACT_TOPICS.find(
      t => t.toLowerCase() === topicPreference.toLowerCase() ||
           t.toLowerCase().includes(topicPreference.toLowerCase())
    );
    if (matched) {
      topic = matched;
    }
  }

  const ai = getGeminiClient();
  if (ai) {
    console.log(`[JokeFact] Attempting to generate Fact with Gemini API for topic: ${topic}`);
    try {
      const prompt = `Generate a random, highly interesting, educational, and amazing fact on the topic: "${topic}".
The fact must be completely true, accurate, family-friendly, and amazing.
Return the fact strictly as a JSON object containing "fact" (one engaging sentence) and "explanation" (a brief context or background explanation to make it informative and entertaining).`;

      const modelsToTry = ['gemini-3.6-flash', 'gemini-flash-latest'];
      let responseText: string | undefined;

      for (const modelName of modelsToTry) {
        try {
          const response = await ai.models.generateContent({
            model: modelName,
            contents: prompt,
            config: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: 'OBJECT',
                properties: {
                  fact: { type: 'STRING' },
                  explanation: { type: 'STRING' }
                },
                required: ['fact', 'explanation']
              }
            }
          });
          responseText = response.text;
          if (responseText) break;
        } catch (modelErr) {
          console.warn(`[JokeFact] Fact generation failed with model ${modelName}, trying fallback...`);
        }
      }
      if (responseText) {
        const parsed: any = JSON.parse(responseText);
        if (parsed.fact && parsed.explanation) {
          const generatedFact: Fact = {
            topic,
            fact: parsed.fact.trim(),
            explanation: parsed.explanation.trim()
          };

          // Check if this newly generated fact is a duplicate in user's recent history
          if (!isRecentFact(userKey, generatedFact.fact as any)) {
            // Expand our offline database over time!
            const existsInCache = currentFacts.some(
              f => f.fact.toLowerCase() === generatedFact.fact.toLowerCase()
            );
            if (!existsInCache) {
              currentFacts.push(generatedFact);
              saveFactsToDisk();
            }

            addToRecentFacts(userKey, generatedFact.fact);
            return generatedFact;
          }
          console.log('[JokeFact] Generated fact was recently seen, falling back to offline/cache.');
        }
      }
    } catch (err) {
      console.error('[JokeFact] Gemini API fact generation failed, falling back to local database:', err);
    }
  }

  // FALLBACK TO OFFLINE / CACHED DATABASE
  console.log(`[JokeFact] Serving offline fallback fact for topic: ${topic}`);
  
  // Filter cache by requested topic
  let available = currentFacts.filter(
    f => f.topic.toLowerCase() === topic.toLowerCase() ||
         f.topic.toLowerCase().includes(topic.toLowerCase())
  );

  // If no facts exist for this specific topic, use any topic
  if (available.length === 0) {
    available = currentFacts;
  }

  // Try to find one that wasn't recently sent
  let selected = available.find(f => !isRecentFact(userKey, f.fact as any));
  
  // Ultimate fallback if all were recently sent
  if (!selected) {
    selected = available[Math.floor(Math.random() * available.length)];
  }

  if (selected) {
    addToRecentFacts(userKey, selected.fact);
    return selected;
  }

  // Absolute fallback
  return BASE_FACTS[0];
}

// Initialize the caches on module load
initJokeFactCache();

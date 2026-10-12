const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const PROJECT_ROOT = path.resolve(ROOT, '..');
const UPLOAD_DIR = process.env.MENSWEAR_UPLOAD_DIR ? path.resolve(process.env.MENSWEAR_UPLOAD_DIR) : path.join(PROJECT_ROOT, 'frontend', 'public', 'uploads');
const DATA_DIR = process.env.MENSWEAR_DATA_DIR ? path.resolve(process.env.MENSWEAR_DATA_DIR) : path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'site-data.json');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');

const STOCK_IMAGES = {
  hero: 'https://images.unsplash.com/photo-1617137968427-85924c800a22?auto=format&fit=crop&w=2200&q=85',
  suiting: 'https://images.unsplash.com/photo-1592878904946-b3cd8ae243d0?auto=format&fit=crop&w=1400&q=85',
  raymond: 'https://images.unsplash.com/photo-1551488831-00ddcb6c6bd3?auto=format&fit=crop&w=1200&q=80',
  linen: 'https://images.unsplash.com/photo-1598033129183-c4f50c736f10?auto=format&fit=crop&w=1200&q=80',
  shirting: 'https://images.unsplash.com/photo-1603252109303-2751441dd157?auto=format&fit=crop&w=1200&q=80',
  trousers: 'https://images.unsplash.com/photo-1473966968600-fa801b869a1a?auto=format&fit=crop&w=1200&q=80',
  tailoring: 'https://images.unsplash.com/photo-1593030761757-71fae45fa0e7?auto=format&fit=crop&w=1400&q=80',
  detail: 'https://images.unsplash.com/photo-1591047139829-d91aecb6caea?auto=format&fit=crop&w=1400&q=80'
};

function makeId(prefix = 'item') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function defaultData() {
  return {
    version: 1,
    settings: {
      businessName: 'YOUR STORE NAME',
      tagline: "MEN'S FABRICS · TAILORING · SUITING",
      intro: 'A considered destination for men’s fabrics, tailored essentials, and suiting for life’s important moments.',
      heroHeadline: 'Elegance, tailored to you.',
      heroSubheadline: 'Discover fine fabrics, thoughtful fit, and menswear shaped around your personal style.',
      heroImage: '',
      heroImageUrl: STOCK_IMAGES.hero,
      phone: '',
      whatsapp: '',
      email: '',
      address: '',
      openingHours: '',
      // Manual daily status expires unless its date matches today's Asia/Kolkata date.
      dailyStoreStatus: 'call_to_confirm',
      dailyStoreStatusDate: '',
      dailyStoreStatusNote: '',
      dailyStoreSpecialHours: '',
      dailyStoreStatusUpdatedAt: '',
      storeExceptions: [],
      mapUrl: '',
      mapEmbedUrl: '',
      instagramUrl: '',
      facebookUrl: '',
      announcementBar: '',
      announcementBarActive: false
    },
    categories: [
      { id: 'cat-suiting', name: 'Suiting Fabrics', slug: 'suiting-fabrics', description: 'Explore suiting options for business, weddings, celebrations, and formal occasions. Visit the store to review current fabrics and discuss tailoring.', image: '', imageUrl: STOCK_IMAGES.suiting, sortOrder: 1 },
      { id: 'cat-raymond', name: 'Raymond Fabrics', slug: 'raymond-fabrics', description: 'Discover the Raymond fabrics available at our store. Current designs and availability can be confirmed in person.', image: '', imageUrl: STOCK_IMAGES.raymond, sortOrder: 2 },
      { id: 'cat-linen', name: 'Linen Fabrics', slug: 'linen-fabrics', description: 'A relaxed fabric direction for breathable, understated menswear. Visit us to explore the linen options currently available.', image: '', imageUrl: STOCK_IMAGES.linen, sortOrder: 3 },
      { id: 'cat-shirting', name: 'Shirting Fabrics', slug: 'shirting-fabrics', description: 'Explore fabric options for shirts suited to your preferred style, occasion, and fit.', image: '', imageUrl: STOCK_IMAGES.shirting, sortOrder: 4 },
      { id: 'cat-trouser', name: 'Trouser Fabrics', slug: 'trouser-fabrics', description: 'Find fabric options for tailored trousers and coordinated formalwear. Visit the store to check current choices.', image: '', imageUrl: STOCK_IMAGES.trousers, sortOrder: 5 }
    ],
    collections: [],
    gallery: [],
    announcements: [],
    testimonials: [],
    enquiries: []
  };
}

async function ensureDataFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const seedFile = path.join(ROOT, 'data', 'seed-site-data.json');
    let initial = defaultData();
    try {
      const seed = JSON.parse(await fs.readFile(seedFile, 'utf8'));
      const defaults = defaultData();
      initial = {
        ...defaults,
        ...seed,
        settings: { ...defaults.settings, ...(seed.settings || {}) },
        categories: Array.isArray(seed.categories) ? seed.categories : defaults.categories,
        collections: Array.isArray(seed.collections) ? seed.collections : [],
        gallery: Array.isArray(seed.gallery) ? seed.gallery : [],
        announcements: Array.isArray(seed.announcements) ? seed.announcements : [],
        testimonials: Array.isArray(seed.testimonials) ? seed.testimonials : [],
        // The deployment seed must never initialise private customer enquiry records.
        enquiries: []
      };
    } catch (seedError) {
      if (seedError.code !== 'ENOENT') throw new Error(`Could not load the public website seed safely: ${seedError.message}`);
    }
    await atomicWrite(DATA_FILE, initial);
  }
}

async function atomicWrite(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

async function getData() {
  await ensureDataFiles();
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  const saved = JSON.parse(raw);
  const defaults = defaultData();
  return {
    ...defaults,
    ...saved,
    settings: { ...defaults.settings, ...(saved.settings || {}) },
    categories: Array.isArray(saved.categories) ? saved.categories : defaults.categories,
    collections: Array.isArray(saved.collections) ? saved.collections : [],
    gallery: Array.isArray(saved.gallery) ? saved.gallery : [],
    announcements: Array.isArray(saved.announcements) ? saved.announcements : [],
    testimonials: Array.isArray(saved.testimonials) ? saved.testimonials : [],
    enquiries: Array.isArray(saved.enquiries) ? saved.enquiries : []
  };
}

// Serialize mutations so simultaneous enquiries/admin updates do not overwrite one another.
let mutationQueue = Promise.resolve();
function updateData(mutator) {
  const operation = mutationQueue.then(async () => {
    const data = await getData();
    const result = await mutator(data);
    await atomicWrite(DATA_FILE, data);
    return result;
  });
  mutationQueue = operation.catch(() => {});
  return operation;
}

async function getAdmin() {
  try {
    const raw = await fs.readFile(ADMIN_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function saveAdmin(admin) {
  await atomicWrite(ADMIN_FILE, admin);
  // Best-effort restrictive permissions for Unix-like systems; Windows uses its normal ACL model.
  await fs.chmod(ADMIN_FILE, 0o600).catch(() => {});
}

module.exports = {
  ROOT,
  DATA_DIR,
  DATA_FILE,
  ADMIN_FILE,
  STOCK_IMAGES,
  makeId,
  defaultData,
  ensureDataFiles,
  getData,
  updateData,
  getAdmin,
  saveAdmin
};

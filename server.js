require('dotenv').config();
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');

const app = express();
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/folio';
const dbName = process.env.MONGODB_DB || 'folio';
const mongoClient = new MongoClient(mongoUri);
const clientPromise = mongoClient.connect();
const database = mongoClient.db(dbName);
const collections = {
  users: database.collection('users'),
  portfolios: database.collection('portfolios'),
  projects: database.collection('projects'),
  views: database.collection('portfolio_views'),
  messages: database.collection('contact_messages')
};
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const emailTransport = process.env.SMTP_HOST ? nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true', auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined }) : null;

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:', 'https:'], scriptSrc: ["'self'", "'unsafe-inline'"], connectSrc: ["'self'", 'https://api.github.com'], frameAncestors: ["'none'"] } } }));
app.use(express.json({ limit: '1mb' }));
app.use(session({
  store: MongoStore.create({ clientPromise, dbName, collectionName: 'sessions' }),
  name: 'folio.sid',
  secret: process.env.SESSION_SECRET || 'development-only-change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 1000 * 60 * 60 * 24 * 14 }
}));

async function initializeDatabase() {
  await Promise.all([
    collections.users.createIndex({ email: 1 }, { unique: true }),
    collections.portfolios.createIndex({ userId: 1 }, { unique: true }),
    collections.portfolios.createIndex({ slug: 1 }, { unique: true }),
    collections.projects.createIndex({ userId: 1, position: 1, _id: 1 }),
    collections.views.createIndex({ portfolioUserId: 1, viewedAt: -1 }),
    collections.messages.createIndex({ portfolioUserId: 1, createdAt: -1 })
  ]);
}

const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
function requireAuth(req, res, next) { if (!req.session.userId) return res.status(401).json({ error: 'Please sign in to continue.' }); next(); }
function cleanString(value, max = 4000) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function externalUrl(value) { const text = cleanString(value, 1000); try { const url = new URL(text); return ['http:', 'https:'].includes(url.protocol) ? url.toString() : ''; } catch { return ''; } }
function safeSlug(value) { return cleanString(value, 60).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'portfolio'; }
function objectId(value) { return typeof value === 'string' && ObjectId.isValid(value) ? new ObjectId(value) : null; }
function projectResponse(project) {
  return { id: project._id.toString(), title: project.title, description: project.description, stack: project.stack, github: project.github, live: project.live, image: project.image };
}
async function getPortfolio(userId) {
  const [portfolio, user] = await Promise.all([
    collections.portfolios.findOne({ userId }),
    collections.users.findOne({ _id: userId }, { projection: { email: 1 } })
  ]);
  if (!portfolio || !user) return null;
  const projects = await collections.projects.find({ userId }).sort({ position: 1, _id: 1 }).toArray();
  return {
    id: userId.toString(),
    name: portfolio.name,
    slug: portfolio.slug,
    role: portfolio.role,
    bio: portfolio.bio,
    email: portfolio.email || user.email,
    location: portfolio.location,
    school: portfolio.school,
    degree: portfolio.degree,
    gradYear: portfolio.gradYear,
    experience: portfolio.experience,
    skills: portfolio.skills,
    phone: portfolio.phone,
    profileImage: portfolio.profileImage,
    behance: portfolio.behance,
    traits: portfolio.traits,
    cvEducation: portfolio.cvEducation,
    languages: portfolio.languages,
    expertise: portfolio.expertise,
    achievements: portfolio.achievements,
    references: portfolio.references,
    fatherName: portfolio.fatherName,
    dateOfBirth: portfolio.dateOfBirth,
    gender: portfolio.gender,
    maritalStatus: portfolio.maritalStatus,
    github: portfolio.github,
    linkedin: portfolio.linkedin,
    website: portfolio.website,
    template: portfolio.template,
    accent: portfolio.accent,
    font: portfolio.font,
    projects: projects.map(projectResponse)
  };
}
function validateEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function isDuplicateKey(err) { return err && err.code === 11000; }

app.post('/api/auth/signup', authLimit, async (req, res, next) => {
  let userId;
  try {
    const email = cleanString(req.body.email, 254).toLowerCase();
    const password = String(req.body.password || '');
    const name = cleanString(req.body.name, 100) || email.split('@')[0];
    if (!validateEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 10) return res.status(400).json({ error: 'Use a password with at least 10 characters.' });

    const user = await collections.users.insertOne({ email, passwordHash: await bcrypt.hash(password, 12), createdAt: new Date() });
    userId = user.insertedId;
    const baseSlug = safeSlug(name.replace(/\s+/g, '-'));
    const portfolio = {
      userId,
      name,
      slug: baseSlug,
      role: '',
      bio: '',
      email,
      location: '',
      school: '',
      degree: '',
      gradYear: '',
      experience: '',
      skills: [],
      github: '',
      linkedin: '',
      website: '',
      template: 'minimal',
      accent: '#6f895d',
      font: 'Manrope',
      updatedAt: new Date()
    };
    try {
      await collections.portfolios.insertOne(portfolio);
    } catch (err) {
      if (!isDuplicateKey(err) || !err.keyPattern || !err.keyPattern.slug) throw err;
      portfolio.slug = `${baseSlug.slice(0, 48)}-${userId.toString().slice(-8)}`;
      await collections.portfolios.insertOne(portfolio);
    }

    req.session.userId = userId.toString();
    res.status(201).json({ user: { id: userId.toString(), email } });
  } catch (err) {
    if (userId) await collections.users.deleteOne({ _id: userId });
    if (isDuplicateKey(err) && err.keyPattern && err.keyPattern.email) return res.status(409).json({ error: 'An account with this email already exists.' });
    next(err);
  }
});

app.post('/api/auth/login', authLimit, async (req, res, next) => {
  try {
    const email = cleanString(req.body.email, 254).toLowerCase();
    const user = await collections.users.findOne({ email });
    if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.passwordHash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.userId = user._id.toString();
      res.json({ user: { id: user._id.toString(), email: user.email } });
    });
  } catch (err) { next(err); }
});
app.post('/api/auth/logout', (req, res, next) => req.session.destroy(err => { if (err) return next(err); res.clearCookie('folio.sid'); res.status(204).end(); }));
app.get('/api/auth/me', (req, res) => res.json({ user: req.session.userId ? { id: req.session.userId } : null }));

app.get('/api/portfolio', requireAuth, async (req, res, next) => {
  try {
    const userId = objectId(req.session.userId);
    res.json({ portfolio: userId ? await getPortfolio(userId) : null });
  } catch (err) { next(err); }
});
app.put('/api/portfolio', requireAuth, async (req, res, next) => {
  try {
    const b = req.body || {};
    const slug = safeSlug(b.slug);
    const userId = objectId(req.session.userId);
    if (!userId) return res.status(401).json({ error: 'Please sign in to continue.' });
    const fields = {
      name: cleanString(b.name, 100) || 'Your Name',
      slug,
      role: cleanString(b.role, 180),
      bio: cleanString(b.bio, 4000),
      email: cleanString(b.email, 254),
      location: cleanString(b.location, 180),
      school: cleanString(b.school, 180),
      degree: cleanString(b.degree, 180),
      gradYear: cleanString(b.gradYear, 30),
      experience: cleanString(b.experience, 4000),
      skills: Array.isArray(b.skills) ? b.skills.map(x => cleanString(x, 80)).filter(Boolean).slice(0, 50) : [],
      phone: cleanString(b.phone, 40),
      profileImage: externalUrl(b.profileImage),
      behance: externalUrl(b.behance),
      traits: Array.isArray(b.traits) ? b.traits.map(x => cleanString(x, 80)).filter(Boolean).slice(0, 20) : [],
      cvEducation: Array.isArray(b.cvEducation) ? b.cvEducation.map(x => cleanString(x, 240)).filter(Boolean).slice(0, 10) : [],
      languages: Array.isArray(b.languages) ? b.languages.map(x => cleanString(x, 120)).filter(Boolean).slice(0, 20) : [],
      expertise: Array.isArray(b.expertise) ? b.expertise.map(x => cleanString(x, 80)).filter(Boolean).slice(0, 30) : [],
      achievements: Array.isArray(b.achievements) ? b.achievements.map(x => cleanString(x, 240)).filter(Boolean).slice(0, 30) : [],
      references: Array.isArray(b.references) ? b.references.map(x => cleanString(x, 240)).filter(Boolean).slice(0, 20) : [],
      fatherName: cleanString(b.fatherName, 100),
      dateOfBirth: cleanString(b.dateOfBirth, 30),
      gender: cleanString(b.gender, 40),
      maritalStatus: cleanString(b.maritalStatus, 40),
      github: cleanString(b.github, 100),
      linkedin: cleanString(b.linkedin, 500),
      website: cleanString(b.website, 500),
      template: ['minimal', 'editorial', 'studio', 'cv-sidebar', 'cv-header', 'cv-orange'].includes(b.template) ? b.template : 'minimal',
      accent: /^#[0-9a-f]{6}$/i.test(b.accent) ? b.accent : '#6f895d',
      font: ['Manrope', 'DM Sans', 'Georgia'].includes(b.font) ? b.font : 'Manrope',
      updatedAt: new Date()
    };
    await collections.portfolios.updateOne({ userId }, { $set: fields });
    res.json({ portfolio: await getPortfolio(userId) });
  } catch (err) {
    if (isDuplicateKey(err)) return res.status(409).json({ error: 'That portfolio URL is already in use.' });
    next(err);
  }
});
app.post('/api/projects', requireAuth, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!cleanString(b.title, 160)) return res.status(400).json({ error: 'Project title is required.' });
    const userId = objectId(req.session.userId);
    if (!userId) return res.status(401).json({ error: 'Please sign in to continue.' });
    const position = await collections.projects.countDocuments({ userId });
    const project = {
      userId,
      title: cleanString(b.title, 160),
      description: cleanString(b.description, 2000),
      stack: Array.isArray(b.stack) ? b.stack.map(x => cleanString(x, 80)).filter(Boolean).slice(0, 30) : [],
      github: externalUrl(b.github),
      live: externalUrl(b.live),
      image: externalUrl(b.image),
      position,
      createdAt: new Date()
    };
    const result = await collections.projects.insertOne(project);
    res.status(201).json({ project: projectResponse({ ...project, _id: result.insertedId }) });
  } catch (err) { next(err); }
});
app.put('/api/projects/:id', requireAuth, async (req, res, next) => {
  try {
    const b = req.body || {};
    const userId = objectId(req.session.userId);
    const id = objectId(req.params.id);
    if (!userId) return res.status(401).json({ error: 'Please sign in to continue.' });
    if (!id) return res.status(404).json({ error: 'Project not found.' });
    const fields = {
      title: cleanString(b.title, 160),
      description: cleanString(b.description, 2000),
      stack: Array.isArray(b.stack) ? b.stack.map(x => cleanString(x, 80)).filter(Boolean).slice(0, 30) : [],
      github: externalUrl(b.github),
      live: externalUrl(b.live),
      image: externalUrl(b.image)
    };
    const result = await collections.projects.updateOne({ _id: id, userId }, { $set: fields });
    if (!result.matchedCount) return res.status(404).json({ error: 'Project not found.' });
    res.json({ project: projectResponse({ ...fields, _id: id }) });
  } catch (err) { next(err); }
});
app.delete('/api/projects/:id', requireAuth, async (req, res, next) => {
  try {
    const userId = objectId(req.session.userId);
    const id = objectId(req.params.id);
    if (!userId) return res.status(401).json({ error: 'Please sign in to continue.' });
    if (!id || !(await collections.projects.deleteOne({ _id: id, userId })).deletedCount) return res.status(404).json({ error: 'Project not found.' });
    res.status(204).end();
  } catch (err) { next(err); }
});

app.get('/api/analytics', requireAuth, async (req, res, next) => {
  try {
    const userId = objectId(req.session.userId);
    if (!userId) return res.status(401).json({ error: 'Please sign in to continue.' });
    const now = new Date();
    const last24 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const daysStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6));
    const [total, last7Count, last24Count, days] = await Promise.all([
      collections.views.countDocuments({ portfolioUserId: userId }),
      collections.views.countDocuments({ portfolioUserId: userId, viewedAt: { $gt: last7 } }),
      collections.views.countDocuments({ portfolioUserId: userId, viewedAt: { $gt: last24 } }),
      collections.views.aggregate([
        { $match: { portfolioUserId: userId, viewedAt: { $gte: daysStart } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$viewedAt', timezone: 'UTC' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
        { $project: { _id: 0, day: '$_id', count: 1 } }
      ]).toArray()
    ]);
    res.json({ total, last7: last7Count, last24: last24Count, days });
  } catch (err) { next(err); }
});
app.get('/api/public/:slug', async (req, res, next) => {
  try {
    const portfolio = await collections.portfolios.findOne({ slug: safeSlug(req.params.slug) });
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found.' });
    await collections.views.insertOne({ portfolioUserId: portfolio.userId, viewedAt: new Date() });
    res.json({ portfolio: await getPortfolio(portfolio.userId) });
  } catch (err) { next(err); }
});
app.post('/api/contact/:slug', rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false }), async (req, res, next) => {
  try {
    const from = cleanString(req.body.email, 254);
    const message = cleanString(req.body.message, 3000);
    if (!validateEmail(from) || message.length < 5) return res.status(400).json({ error: 'Enter your email and a message of at least 5 characters.' });
    const portfolio = await collections.portfolios.findOne({ slug: safeSlug(req.params.slug) });
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found.' });
    await collections.messages.insertOne({ portfolioUserId: portfolio.userId, senderEmail: from, message, createdAt: new Date() });
    if (!emailTransport) return res.status(503).json({ error: 'Contact email is not configured yet. Please use the portfolio owner’s listed email.' });
    await emailTransport.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to: portfolio.email, replyTo: from, subject: `Portfolio message for ${portfolio.name}`, text: `From: ${from}\n\n${message}` });
    res.json({ sent: true });
  } catch (err) { next(err); }
});

app.use(express.static(path.join(__dirname), { extensions: ['html'], index: 'index.html', maxAge: isProduction ? '1h' : 0 }));
app.get('/:slug', (req, res, next) => { if (req.params.slug.startsWith('api') || req.params.slug.includes('.')) return next(); res.sendFile(path.join(__dirname, 'index.html')); });
app.use((err, req, res, next) => { console.error(err); if (res.headersSent) return next(err); res.status(500).json({ error: 'Something went wrong. Please try again.' }); });

if (isProduction && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) { console.error('Set SESSION_SECRET to a random value of at least 32 characters before deploying.'); process.exit(1); }
clientPromise.then(initializeDatabase).then(() => app.listen(port, () => console.log(`folio is running on http://localhost:${port}`))).catch(err => {
  console.error('Could not connect to MongoDB or initialize the collections.', err);
  process.exit(1);
});

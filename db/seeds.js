/**
 * One-off data the team could not add through the app.
 *
 * Each seed runs once, is recorded in system/seeds, and never touches a
 * record that already exists. This exists because the Srikurmam yatra had to
 * be published while nobody could get into the admin portal; once the team is
 * back in, trips are made in Manage yatras as normal and this file can go.
 */
const { db, admin } = require('../config/firebase');

const stamp = () => admin.firestore.FieldValue.serverTimestamp();

const SEEDS = [
  {
    id: 'srikurmam-yatra-2026-10-10',
    run: async () => {
      // Never duplicate a trip the team may have made in the meantime.
      const existing = await db.collection('trips').where('slug', '==', 'srikurmam-yatra').get();
      if (!existing.empty) return 'already there';

      await db.collection('trips').doc().set({
        slug: 'srikurmam-yatra',
        title: 'Srikurmam Yatra',
        subtitle: 'Kurma-kshetra, Rama Teertham and Ramanarayanam',
        location: 'Srikurmam, Rama Teertham & Ramanarayanam',
        description: [
          "A day's yatra to Srikurmam — the only temple where the Lord is worshipped in His Kurma form, and a place Sri Chaitanya Mahaprabhu visited on His South Indian tour. From there we travel on to Rama Teertham and Ramanarayanam.",
          'The whole day is spent together: kirtan along the way, the pastimes of the Lord heard at each holy place, darshan, and maha prasadam.',
          // No rupee sign in stored text: the price block on the page already
          // shows it, and we have never confirmed the production database
          // accepts that character.
          'The yatra costs 1,300 rupees a person. The temple is giving the rest, so your share is just 49.',
        ].join('\n\n'),
        coverImage: '',
        gallery: [],
        startDate: '2026-10-10',
        endDate: '2026-10-10',
        durationLabel: '1 day',
        price: 49,
        originalPrice: 1300,
        advanceAmount: 0,
        capacity: 25,
        eligibility: 'Boys only',
        status: 'upcoming',
        registrationOpen: true,
        onlinePaymentEnabled: true,
        cashPaymentEnabled: false,
        highlights: [
          'Darshan at Srikurmam',
          'Rama Teertham',
          'Ramanarayanam',
          'Maha prasadam',
          'Kirtan through the journey',
          'Pastimes at every stop',
        ],
        itinerary: [],
        locations: [],
        inclusions: ['Travel', 'Maha prasadam', 'Darshan and guided pastimes'],
        exclusions: [],
        meetingPoint: 'FOLK Residency, Opp. Silver Oaks',
        contactPhone: '8977761187',
        createdBy: 'seed',
        createdAt: stamp(),
        updatedAt: stamp(),
      });
      return 'created';
    },
  },
];

/**
 * Which accounts can actually reach the admin portal. Printed once at start
 * so the team can be told which login to use when they are locked out.
 * Staff only, and only their sign-in name — no member data.
 */
const reportAdmins = async () => {
  try {
    const [admins, guides] = await Promise.all([
      db.collection('users').where('role', '==', 'admin').get(),
      db.collection('users').where('role', '==', 'folks_head').get(),
    ]);
    const who = admins.docs
      .map((d) => d.data().email || d.data().username || d.data().phone || d.id)
      .join(', ');
    console.log(`[accounts] ${admins.size} admin account(s)${who ? `: ${who}` : ''}; ${guides.size} FOLK guide(s)`);
  } catch (error) {
    console.error('[accounts] could not be listed:', error.message);
  }
};

const runSeeds = async () => {
  try {
    await reportAdmins();
    const ref = db.collection('system').doc('seeds');
    const snap = await ref.get();
    const done = (snap.exists && Array.isArray(snap.data().done)) ? snap.data().done : [];

    for (const seed of SEEDS) {
      if (done.includes(seed.id)) continue;
      const outcome = await seed.run();
      done.push(seed.id);
      console.log(`[seed] ${seed.id}: ${outcome}`);
    }
    await ref.set({ done, updatedAt: stamp() }, { merge: true });
  } catch (error) {
    // A seed must never stop the server from serving.
    console.error('[seed] failed:', error.message);
  }
};

module.exports = { runSeeds };

import type {
  User,
  Destination,
  Post,
  Trip,
  Conversation,
  AppNotification,
  ChatMessage,
} from '../types/models';

/* Images: Unsplash source URLs (stable IDs). Replace with backend media later. */
const img = (id: string, w = 1200) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${w}&q=70`;
const face = (n: number) =>
  `https://i.pravatar.cc/240?img=${n}`;

export const me: User = {
  id: 'u_me',
  handle: 'driftwithdrae',
  name: 'Drae',
  avatarUrl: face(12),
  homeCity: 'Lapu-Lapu City',
  homeCountry: 'Philippines',
  currentCity: 'Cebu City',
  travelStyle: 'solo',
  interests: ['beach', 'nightlife', 'food', 'photography'],
  verified: true,
  openToMeet: true,
  isPrivate: false,
  followers: 1840,
  following: 312,
  bio: 'Island-hopping the Visayas. Beach by day, IT Park by night.',
};

export const users: User[] = [
  {
    id: 'u_1', handle: 'maya.roams', name: 'Maya Lindqvist', avatarUrl: face(5),
    homeCity: 'Stockholm', homeCountry: 'Sweden', currentCity: 'Cebu City',
    travelStyle: 'solo', interests: ['beach', 'wellness', 'food'],
    verified: true, openToMeet: true, isPrivate: false, followers: 9200, following: 410,
    bio: 'Slow travel, warm water, good coffee.',
  },
  {
    id: 'u_2', handle: 'thekochs', name: 'Ben & Lena', avatarUrl: face(33),
    homeCity: 'Munich', homeCountry: 'Germany', currentCity: 'Mactan',
    travelStyle: 'couple', interests: ['luxury', 'beach', 'food'],
    verified: false, openToMeet: false, isPrivate: false, followers: 540, following: 280,
  },
  {
    id: 'u_3', handle: 'kojo.eats', name: 'Kojo Mensah', avatarUrl: face(15),
    homeCity: 'Accra', homeCountry: 'Ghana', currentCity: 'Cebu City',
    travelStyle: 'solo', interests: ['food', 'nightlife', 'culture'],
    verified: true, openToMeet: true, isPrivate: false, followers: 21400, following: 190,
    bio: 'I find the food. You bring the appetite.',
  },
  {
    id: 'u_4', handle: 'sari.dives', name: 'Sari Putri', avatarUrl: face(45),
    homeCity: 'Jakarta', homeCountry: 'Indonesia', currentCity: 'Moalboal',
    travelStyle: 'group', interests: ['adventure', 'beach', 'photography'],
    verified: false, openToMeet: true, isPrivate: false, followers: 3100, following: 520,
  },
];

const byId = Object.fromEntries(users.map((u) => [u.id, u]));

export const cebu: Destination = {
  id: 'd_cebu',
  city: 'Cebu',
  country: 'Philippines',
  slug: 'cebu',
  coverUrl: img('photo-1519046904884-53103b34b206'),
  blurb:
    'Island capital of the Visayas. Beaches and dive sites on Mactan and Moalboal, nightlife and food downtown and at IT Park.',
  travelerCount: 1284,
  trending: true,
};

const dRef = { id: cebu.id, city: cebu.city, country: cebu.country, slug: cebu.slug };

export const posts: Post[] = [
  {
    id: 'p_1', kind: 'hero', category: 'beach', author: byId.u_1, destination: dRef,
    title: 'Mactan at 6am before the boats wake up',
    caption: 'Came for the diving, stayed for the empty mornings.',
    media: [{ id: 'm1', url: img('photo-1505228395891-9a51e7e86bf6'), kind: 'image', brightness: 0.42 }],
    bestFor: ['beach', 'photography'], createdAt: '2026-06-13T22:10:00Z',
    likeCount: 1290, commentCount: 84, saveCount: 410, liked: false, saved: true,
  },
  {
    id: 'p_2', kind: 'hero', category: 'nightlife', author: byId.u_3, destination: dRef,
    title: 'IT Park doesn’t sleep and neither did we',
    caption: 'Street food → rooftop → live band. Full loop under ₱1500.',
    media: [{ id: 'm2', url: img('photo-1566737236500-c8ac43014a67'), kind: 'image', brightness: 0.3 }],
    bestFor: ['nightlife', 'food'], costLevel: 2, createdAt: '2026-06-14T15:40:00Z',
    likeCount: 2210, commentCount: 156, saveCount: 690, liked: true, saved: false,
  },
  {
    id: 'p_3', kind: 'standard', category: 'food', author: byId.u_3, destination: dRef,
    caption:
      'Lechon at this hole-in-the-wall in Carbon market beats every fancy place I tried. Ask for the crispy shoulder. ₱180 a plate, rice included.',
    media: [{ id: 'm3', url: img('photo-1455619452474-d2be8b1e70cd'), kind: 'image', brightness: 0.55 }],
    rating: 5, costLevel: 1, bestFor: ['food'], createdAt: '2026-06-14T09:05:00Z',
    likeCount: 540, commentCount: 38, saveCount: 120, liked: false, saved: false,
  },
  {
    id: 'p_4', kind: 'question', category: 'question', author: byId.u_2, destination: dRef,
    title: 'Is Moalboal worth it if we only have 4 nights?',
    caption:
      'We’re based in Mactan for the resort. Moalboal sardine run looks unreal but it’s ~3 hours each way. Day trip or overnight? Worth skipping a beach day for?',
    media: [], createdAt: '2026-06-14T11:20:00Z',
    likeCount: 22, commentCount: 31, saveCount: 8, liked: false, saved: false,
  },
  {
    id: 'p_5', kind: 'itinerary', category: 'activity', author: byId.u_4, destination: dRef,
    title: 'Cebu in 3 days: beach + dive + one big night',
    caption: 'Mactan base, Moalboal day trip, downtown send-off.',
    media: [{ id: 'm5', url: img('photo-1518509562904-e7ef99cdcc86'), kind: 'image', brightness: 0.48 }],
    dayCount: 3, bestFor: ['beach', 'adventure', 'nightlife'], createdAt: '2026-06-12T18:00:00Z',
    likeCount: 870, commentCount: 64, saveCount: 305, liked: false, saved: true,
  },
  {
    id: 'p_6', kind: 'standard', category: 'safety', author: byId.u_1, destination: dRef,
    caption:
      'PSA for solo travelers: the white taxis at the airport are metered and fine, just insist on the meter. Skip anyone quoting a flat ₱500 to the city. Grab works great here too.',
    media: [], safetyNote: true, createdAt: '2026-06-13T08:30:00Z',
    likeCount: 410, commentCount: 52, saveCount: 200, liked: true, saved: true,
  },
  {
    id: 'p_7', kind: 'hero', category: 'hotel', author: byId.u_2, destination: dRef,
    title: 'The infinity pool earns the price tag',
    caption: 'Mactan resort strip. Worth one splurge night.',
    media: [{ id: 'm7', url: img('photo-1571896349842-33c89424de2d'), kind: 'image', brightness: 0.5 }],
    rating: 4, costLevel: 4, bestFor: ['luxury', 'beach'], createdAt: '2026-06-11T13:15:00Z',
    likeCount: 1530, commentCount: 90, saveCount: 520, liked: false, saved: false,
  },
];

export const trips: Trip[] = [
  {
    id: 't_1', title: 'Visayas, June', destination: dRef,
    coverUrl: img('photo-1518509562904-e7ef99cdcc86'),
    startDate: '2026-06-20', endDate: '2026-06-27',
    collaborators: [byId.u_1], savedPostIds: ['p_1', 'p_5'], dayCount: 7, isPublic: false,
  },
];

export const conversations: Conversation[] = [
  {
    id: 'c_1', participants: [me, byId.u_1], lastMessage: 'Diving Mactan Thursday — in?',
    lastAt: '2026-06-14T16:02:00Z', unread: 2,
  },
  {
    id: 'c_2', participants: [me, byId.u_3], lastMessage: 'Sending you the lechon spot 🐷',
    lastAt: '2026-06-14T10:11:00Z', unread: 0,
  },
];

export const notifications: AppNotification[] = [
  { id: 'n_1', kind: 'nearby', actor: byId.u_3, text: 'Kojo is in Cebu City and open to meet', createdAt: '2026-06-14T16:30:00Z', read: false },
  { id: 'n_2', kind: 'answer', actor: byId.u_1, text: 'Maya answered your question about Moalboal', createdAt: '2026-06-14T12:00:00Z', read: false },
  { id: 'n_3', kind: 'like', actor: byId.u_4, text: 'Sari and 12 others liked your post', createdAt: '2026-06-13T20:00:00Z', read: true },
  { id: 'n_4', kind: 'trend', text: 'Cebu is trending this week', createdAt: '2026-06-13T09:00:00Z', read: true },
];

export const aiOpening: ChatMessage[] = [
  {
    id: 'ai_0', role: 'assistant',
    text: 'I read traveler posts, your saves, and community answers to plan. Try: “Turn my saved Cebu posts into a 3-day trip” or “Beach + nightlife balance for 4 nights”.',
  },
];

export function postById(id: string): Post | undefined {
  return posts.find((p) => p.id === id);
}
export function userByHandle(handle: string): User | undefined {
  return [me, ...users].find((u) => u.handle === handle);
}

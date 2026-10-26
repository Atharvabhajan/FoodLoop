// Bundled photographs (served from /photos, never hotlinked). Licence data copied from each Wikimedia Commons file page.
export type PhotoName = 'hero-handover' | 'volunteers-serving' | 'cooked-thali' | 'cooked-plate' | 'bakery-loaves' | 'bakery-trays' | 'produce-market' | 'packaged-tiffin' | 'volunteer-handoff' | 'provider-kitchen';

export interface PhotoCredit { alt: string; title: string; author: string; license: string; source: string; width: number; height: number }

export const photos: Record<PhotoName, PhotoCredit> = {
  "hero-handover": {
    "alt": "Two volunteers lifting boxes of donated food at a community distribution point",
    "title": "Jimmy Panetta distributing food at the Food Bank for Monterey County 01.jpg",
    "author": "Creator:Jimmy Panetta",
    "license": "Public domain",
    "source": "https://commons.wikimedia.org/wiki/File:Jimmy_Panetta_distributing_food_at_the_Food_Bank_for_Monterey_County_01.jpg",
    "width": 1600,
    "height": 1164
  },
  "volunteers-serving": {
    "alt": "Smiling volunteers in aprons and gloves serving hot plates of food to families at a community meal",
    "title": "Thanksgiving lunch at USO (5994609).jpg",
    "author": "U.S. Army USAG-V by Laura Kreider",
    "license": "Public domain",
    "source": "https://commons.wikimedia.org/wiki/File:Thanksgiving_lunch_at_USO_(5994609).jpg",
    "width": 1200,
    "height": 803
  },
  "cooked-thali": {
    "alt": "A steel thali plate with rice, flatbread, curry and sides",
    "title": "Malwani Chicken Thali.jpg",
    "author": "Shailesh V Nigawale",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Malwani_Chicken_Thali.jpg",
    "width": 900,
    "height": 765
  },
  "cooked-plate": {
    "alt": "A thali with rice, flatbread and several small bowls of curries",
    "title": "Darjeeling, India, Indian Thali meal.jpg",
    "author": "Vyacheslav Argenberg",
    "license": "CC BY 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Darjeeling,_India,_Indian_Thali_meal.jpg",
    "width": 900,
    "height": 600
  },
  "bakery-loaves": {
    "alt": "Rows of freshly baked loaves on wooden bakery shelves",
    "title": "Loaves of Bread (Unsplash).jpg",
    "author": "Clark Young clark1",
    "license": "CC0",
    "source": "https://commons.wikimedia.org/wiki/File:Loaves_of_Bread_(Unsplash).jpg",
    "width": 900,
    "height": 599
  },
  "bakery-trays": {
    "alt": "Trays of golden bread loaves just out of the oven",
    "title": "US Navy 090716-N-6720T-017 Culinary Specialist Seaman Samantha Garza butters loaves of fresh baked bread in the bakeshop aboard the aircraft carrier USS George Washington (CVN 73).jpg",
    "author": "U.S. Navy photo by Mass Communication Specialist Seaman Adam K. Thomas",
    "license": "Public domain",
    "source": "https://commons.wikimedia.org/wiki/File:US_Navy_090716-N-6720T-017_Culinary_Specialist_Seaman_Samantha_Garza_butters_loaves_of_fresh_baked_bread_in_the_bakeshop_aboard_the_aircraft_carrier_USS_George_Washington_(CVN_73).jpg",
    "width": 900,
    "height": 643
  },
  "produce-market": {
    "alt": "Crates of fresh greens, cabbages, aubergines and bananas at a market stall",
    "title": "Outdoor market fruit and vegetable stall Market Place Romford London 01.jpg",
    "author": "Acabashi",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Outdoor_market_fruit_and_vegetable_stall_Market_Place_Romford_London_01.jpg",
    "width": 900,
    "height": 675
  },
  "packaged-tiffin": {
    "alt": "Two open steel tiffin tins with a grain dish and fruit",
    "title": "First tiffin lunch.jpg",
    "author": "bandita",
    "license": "CC BY-SA 2.0",
    "source": "https://commons.wikimedia.org/wiki/File:First_tiffin_lunch.jpg",
    "width": 900,
    "height": 675
  },
  "volunteer-handoff": {
    "alt": "Two volunteers in teal shirts passing a packed parcel of food across a table in a food bank warehouse",
    "title": "DHS Secretary Alejandro Mayorkas Volunteers at Capital Area Food Bank (52519257457).jpg",
    "author": "DHSgov",
    "license": "Public domain",
    "source": "https://commons.wikimedia.org/wiki/File:DHS_Secretary_Alejandro_Mayorkas_Volunteers_at_Capital_Area_Food_Bank_(52519257457).jpg",
    "width": 1000,
    "height": 667
  },
  "provider-kitchen": {
    "alt": "A chef chopping vegetables on a green board in a commercial kitchen",
    "title": "Michael (Unsplash).jpg",
    "author": "Toa Heftiba heftiba",
    "license": "CC0",
    "source": "https://commons.wikimedia.org/wiki/File:Michael_(Unsplash).jpg",
    "width": 900,
    "height": 600
  }
};

export const photoSrc = (name: PhotoName) => `/photos/${name}.jpg`;

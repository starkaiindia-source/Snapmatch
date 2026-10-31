/* ============================================================================
   Mobile Parts Finder · api/_schema/shop-standard.js
   ----------------------------------------------------------------------------
   The categories every Quick Billing shop starts with.

   Categories are stored per shop (shops/{uid}/categories) because a shop may
   rename, reorder or remove them. This list is what a shop is given once, by
   ensureCatalog() in shop-service, in this order. `order` on the stored document
   is what the app sorts by afterwards, so nothing depends on the alphabet or on
   the order documents happened to be written in.

   The compatibility settings are starting points, and a shop can change them.

     compat        whether products here link to compatibility groups
     partCategory  which catalogue part category those groups come from
     deviceKind    set when a product here IS a device: the master database it
                   is picked from
   ========================================================================== */
'use strict';

/* Bumped when the list changes, so every shop picks up the new entries once. */
const CATALOG_VERSION = 1;

const DEVICE_KINDS = ['phone', 'tablet', 'watch'];

const STANDARD_CATEGORIES = [
  { key: 'mobiles', name: 'Mobiles', description: 'Phones sold as devices, each one a model from the master database.', compat: false, partCategory: null, deviceKind: 'phone' },
  { key: 'tempered-glass', name: 'Tempered Glass', description: 'Screen protectors, linked to the models each one fits.', compat: true, partCategory: 'screen-guards', deviceKind: null },
  { key: 'back-cover', name: 'Back Cover', description: 'Back covers and cases, linked to the models each one fits.', compat: true, partCategory: 'back-cover', deviceKind: null },
  { key: 'smart-watch', name: 'Smart Watch', description: 'Smart watches, each one a model from the master database.', compat: false, partCategory: null, deviceKind: 'watch' },
  { key: 'earbuds', name: 'Earbuds', description: 'Wireless earbuds and earphones.', compat: false, partCategory: null, deviceKind: null },
  { key: 'charger', name: 'Charger', description: 'Wall chargers and adapters.', compat: false, partCategory: null, deviceKind: null },
  { key: 'cable', name: 'Cable', description: 'Charging and data cables.', compat: false, partCategory: null, deviceKind: null },
  { key: 'combo-display', name: 'Combo Display', description: 'Display and touch assemblies, linked to the models each one fits.', compat: true, partCategory: 'combo-display', deviceKind: null },
  { key: 'battery', name: 'Battery', description: 'Replacement batteries, linked to the models each one fits.', compat: true, partCategory: 'battery', deviceKind: null },
  { key: 'middle-frame', name: 'Middle Frame', description: 'Middle frames and housings, linked to the models each one fits.', compat: true, partCategory: 'middle-frame', deviceKind: null },
  { key: 'cc-board', name: 'CC Board', description: 'Charging boards, linked to the models each one fits.', compat: true, partCategory: 'cc-board', deviceKind: null },
  { key: 'service-spares', name: 'Service Spares', description: 'Other repair parts and service items.', compat: false, partCategory: null, deviceKind: null }
];

/* Offered on top of the standard list, added only when a shop asks. */
const SUGGESTED_CATEGORIES = ['Display', 'Charging Board', 'Flex Cable', 'Other Accessories'];

module.exports = { CATALOG_VERSION, DEVICE_KINDS, STANDARD_CATEGORIES, SUGGESTED_CATEGORIES };

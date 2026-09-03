/* ============================================================================
   Mobile Parts Finder · types.js — the data contract
   ----------------------------------------------------------------------------
   Every shape the UI reads, declared in one place.

   WHY JSDOC AND NOT TYPESCRIPT
     The site ships as plain files with no build step — that is what lets
     Vercel serve it statically and what keeps the GitHub -> Vercel flow a
     single push with nothing to compile. Introducing TypeScript would mean a
     toolchain, a build output and a different deployment. JSDoc gives the same
     editor autocomplete and the same `tsc --checkJs` type checking if you ever
     want it, with none of that. Switch later by renaming files and deleting
     these comments; the shapes are already written.

   WHY IT MATTERS NOW
     These are the shapes the Firestore documents must match. `backend/schema.js`
     stores exactly these fields, so when the real data replaces the sample
     generator the UI does not change — it reads `device.specs.chipset` either
     way. Keep the two in step; they are two halves of one contract.

   This file declares types only. It contains no runtime code and adding some
   would defeat its purpose.
   ========================================================================== */

/* --------------------------------------------------------------------- enums */

/** @typedef {'phone'|'tablet'|'watch'} DeviceType */

/** Decides which tempered glass and back cover fit. @typedef {'flat'|'curved'} ScreenCurve */

/** @typedef {'flag'|'mid'|'entry'} Tier */

/** @typedef {'monthly'|'yearly'} BillingPeriod */

/** @typedef {'none'|'pending'|'active'|'cancelling'|'expired'|'cancelled'} AccessState */

/* -------------------------------------------------------------------- brand */

/**
 * @typedef {object} BrandCounts
 * @property {number} total     every device, all classes
 * @property {number} phones    the headline figure
 * @property {number} flat      flat-screen phones
 * @property {number} curved    curved-screen phones; flat + curved === phones
 * @property {number} tablets
 * @property {number} watches
 */

/**
 * @typedef {object} Brand
 * @property {string}   id          slug — "samsung"
 * @property {string}   name
 * @property {string}   code        short code used on part numbers
 * @property {string}   color       brand colour, for the wordmark rule
 * @property {string[]} aliases     alternate spellings seen in source data
 * @property {string|null} logo     registered logo file, else null and the
 *                                  inline CC0 mark or a wordmark is used
 * @property {number}   modelCount
 * @property {number}   groupCount  compatibility groups mastered by this brand
 * @property {BrandCounts} counts
 */

/* ------------------------------------------------------------------ variant */

/**
 * One purchasable configuration. A device without variants (a watch) has
 * exactly one; a flagship can have nine.
 *
 * @typedef {object} Variant
 * @property {string}  id         "12-256"
 * @property {number}  ramGb
 * @property {number}  storageGb
 * @property {number}  priceInr   this configuration's own price, not the base
 * @property {boolean} available
 */

/* --------------------------------------------------------------- specs */

/**
 * @typedef {object} CameraLens
 * @property {number}  mp
 * @property {string}  role       "Wide (main)", "Ultra-wide", "Telephoto 3x optical"
 * @property {string}  aperture
 * @property {boolean} ois
 */

/**
 * @typedef {object} ColorVariant
 * @property {string} n  display name — "Cosmic Orange"
 * @property {string} h  approximate hex, for the swatch
 */

/**
 * The full specification block.
 * Fields with no known value are null, never absent: a missing key reads as an
 * oversight, an explicit null says "this still needs a source" and lets a
 * refresh job find every record that needs filling.
 *
 * @typedef {object} DeviceSpecs
 * @property {string}   chipset
 * @property {string}   cpu
 * @property {string}   gpu
 * @property {string}   fabrication
 * @property {number[]} ramVariantsGb
 * @property {number[]} storageVariantsGb
 * @property {boolean}  expandable
 * @property {Variant[]} variants
 * @property {ColorVariant[]} colors
 * @property {CameraLens[]}   cameraRear
 * @property {{mp:number, aperture:string}} cameraFront
 * @property {string}   videoMax
 * @property {number}   batteryMah
 * @property {string}   batteryType
 * @property {number}   chargingWatts
 * @property {boolean}  wirelessCharging
 * @property {string}   os
 * @property {string}   osVersion
 * @property {string|null} skin        Android skin; null on iOS
 * @property {string}   network        "5G" | "4G LTE"
 * @property {string}   networkDetail
 * @property {string}   wifi
 * @property {string}   bluetooth
 * @property {boolean}  nfc
 * @property {string}   usb
 * @property {boolean}  headphoneJack
 * @property {string[]} sensors
 * @property {number}   launchPriceInr  base variant's price
 * @property {string}   status
 */

/* -------------------------------------------------------------------- device */

/**
 * @typedef {object} Device
 * @property {string}      id           canonical id — "samsung-galaxy-s24"
 * @property {string}      brandId
 * @property {string}      brand
 * @property {string}      modelName    without the brand — "Galaxy S24"
 * @property {string}      fullName     with it
 * @property {string}      search       pre-lowered haystack
 * @property {Tier}        tier
 * @property {DeviceType}  deviceType
 * @property {ScreenCurve} screenCurve
 * @property {number}      releaseYear
 * @property {string}      releaseDate  "April 2024"
 * @property {number}      displaySize  inches
 * @property {string}      screenResolution
 * @property {string}      screenRatio
 * @property {string}      screenType
 * @property {string}      refreshRate
 * @property {string}      ppi
 * @property {string}      height       "158.1 mm"
 * @property {string}      width
 * @property {string}      thickness
 * @property {string}      weight
 * @property {string}      protection
 * @property {string}      sim
 * @property {DeviceSpecs} specs
 * @property {number}      popularity
 */

/* ------------------------------------------------------------ compatibility */

/**
 * One part that fits every device listed in it. The product being sold.
 *
 * @typedef {object} CompatibilityGroup
 * @property {string}   id
 * @property {string}   groupNo
 * @property {string}   categoryId
 * @property {string}   categoryName
 * @property {string}   masterModelId    the device the part is named after
 * @property {string}   masterModelName
 * @property {string}   masterBrandId
 * @property {number}   memberCount
 * @property {string=}  partNo           PAID — absent in the public preview
 * @property {string[]=} memberIds       PAID
 * @property {string[]=} memberNames     PAID
 */

/**
 * @typedef {object} PartCategory
 * @property {string} id
 * @property {string} name
 * @property {string} short
 * @property {string} code
 * @property {number} order
 * @property {string} color   must clear 4.5:1 against white badge text
 */

/* -------------------------------------------------------------- subscription */

/**
 * What /api/subscription returns. The server decides all of it; the client
 * renders it and never computes access itself.
 *
 * @typedef {object} Access
 * @property {AccessState}  state
 * @property {string|null}  plan
 * @property {string|null}  subscriptionId
 * @property {number|null}  startedAt   epoch ms, server clock
 * @property {number|null}  expiresAt   epoch ms, server clock
 * @property {number|null}  lastVerifiedAt
 */

/**
 * @typedef {object} SubscriptionRecord
 * @property {string} subscriptionId   the Razorpay order id
 * @property {string} planId
 * @property {BillingPeriod} billingPeriod
 * @property {number} amount            paise
 * @property {string} currency
 * @property {string} status
 * @property {string|null} paymentId
 * @property {number|null} startedAt
 * @property {number|null} expiresAt
 */

/* ------------------------------------------------------------------ ui state */

/** @typedef {'grid'|'list'|'table'} ModelView */

/**
 * Filters on the brand model list. Null means "no filter", not "false".
 *
 * @typedef {object} ModelFilters
 * @property {ScreenCurve|null} curve
 * @property {DeviceType|null}  deviceType
 * @property {number|null}      year
 * @property {[number,number]|null} sizeRange   inches
 * @property {boolean|null}     fiveG
 * @property {number|null}      minRamGb
 * @property {number|null}      minStorageGb
 * @property {number|null}      minBatteryMah
 */

/** @typedef {'newest'|'oldest'|'name'|'size'|'groups'} ModelSort */

/* This file is documentation for the type checker; there is nothing to export. */

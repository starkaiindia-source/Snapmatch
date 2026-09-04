/* ============================================================================
   Mobile Parts Finder · countries.js
   Full ISO-3166 country list with dialling codes. Flags are derived from the
   ISO alpha-2 code (regional indicator letters), so no image assets and no
   per-country hardcoding.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  /* code:name:dial — packed to keep the payload small */
  var PACKED =
    'AF:Afghanistan:93,AL:Albania:355,DZ:Algeria:213,AD:Andorra:376,AO:Angola:244,' +
    'AG:Antigua and Barbuda:1268,AR:Argentina:54,AM:Armenia:374,AU:Australia:61,AT:Austria:43,' +
    'AZ:Azerbaijan:994,BS:Bahamas:1242,BH:Bahrain:973,BD:Bangladesh:880,BB:Barbados:1246,' +
    'BY:Belarus:375,BE:Belgium:32,BZ:Belize:501,BJ:Benin:229,BT:Bhutan:975,BO:Bolivia:591,' +
    'BA:Bosnia and Herzegovina:387,BW:Botswana:267,BR:Brazil:55,BN:Brunei:673,BG:Bulgaria:359,' +
    'BF:Burkina Faso:226,BI:Burundi:257,KH:Cambodia:855,CM:Cameroon:237,CA:Canada:1,' +
    'CV:Cape Verde:238,CF:Central African Republic:236,TD:Chad:235,CL:Chile:56,CN:China:86,' +
    'CO:Colombia:57,KM:Comoros:269,CG:Congo:242,CD:Congo (DRC):243,CR:Costa Rica:506,' +
    'CI:Cote d Ivoire:225,HR:Croatia:385,CU:Cuba:53,CY:Cyprus:357,CZ:Czechia:420,DK:Denmark:45,' +
    'DJ:Djibouti:253,DM:Dominica:1767,DO:Dominican Republic:1809,EC:Ecuador:593,EG:Egypt:20,' +
    'SV:El Salvador:503,GQ:Equatorial Guinea:240,ER:Eritrea:291,EE:Estonia:372,SZ:Eswatini:268,' +
    'ET:Ethiopia:251,FJ:Fiji:679,FI:Finland:358,FR:France:33,GA:Gabon:241,GM:Gambia:220,' +
    'GE:Georgia:995,DE:Germany:49,GH:Ghana:233,GR:Greece:30,GD:Grenada:1473,GT:Guatemala:502,' +
    'GN:Guinea:224,GW:Guinea-Bissau:245,GY:Guyana:592,HT:Haiti:509,HN:Honduras:504,' +
    'HK:Hong Kong:852,HU:Hungary:36,IS:Iceland:354,IN:India:91,ID:Indonesia:62,IR:Iran:98,' +
    'IQ:Iraq:964,IE:Ireland:353,IL:Israel:972,IT:Italy:39,JM:Jamaica:1876,JP:Japan:81,' +
    'JO:Jordan:962,KZ:Kazakhstan:7,KE:Kenya:254,KI:Kiribati:686,KW:Kuwait:965,' +
    'KG:Kyrgyzstan:996,LA:Laos:856,LV:Latvia:371,LB:Lebanon:961,LS:Lesotho:266,LR:Liberia:231,' +
    'LY:Libya:218,LI:Liechtenstein:423,LT:Lithuania:370,LU:Luxembourg:352,MO:Macau:853,' +
    'MG:Madagascar:261,MW:Malawi:265,MY:Malaysia:60,MV:Maldives:960,ML:Mali:223,MT:Malta:356,' +
    'MH:Marshall Islands:692,MR:Mauritania:222,MU:Mauritius:230,MX:Mexico:52,' +
    'FM:Micronesia:691,MD:Moldova:373,MC:Monaco:377,MN:Mongolia:976,ME:Montenegro:382,' +
    'MA:Morocco:212,MZ:Mozambique:258,MM:Myanmar:95,NA:Namibia:264,NR:Nauru:674,NP:Nepal:977,' +
    'NL:Netherlands:31,NZ:New Zealand:64,NI:Nicaragua:505,NE:Niger:227,NG:Nigeria:234,' +
    'KP:North Korea:850,MK:North Macedonia:389,NO:Norway:47,OM:Oman:968,PK:Pakistan:92,' +
    'PW:Palau:680,PS:Palestine:970,PA:Panama:507,PG:Papua New Guinea:675,PY:Paraguay:595,' +
    'PE:Peru:51,PH:Philippines:63,PL:Poland:48,PT:Portugal:351,QA:Qatar:974,RO:Romania:40,' +
    'RU:Russia:7,RW:Rwanda:250,KN:Saint Kitts and Nevis:1869,LC:Saint Lucia:1758,' +
    'VC:Saint Vincent and the Grenadines:1784,WS:Samoa:685,SM:San Marino:378,' +
    'ST:Sao Tome and Principe:239,SA:Saudi Arabia:966,SN:Senegal:221,RS:Serbia:381,' +
    'SC:Seychelles:248,SL:Sierra Leone:232,SG:Singapore:65,SK:Slovakia:421,SI:Slovenia:386,' +
    'SB:Solomon Islands:677,SO:Somalia:252,ZA:South Africa:27,KR:South Korea:82,' +
    'SS:South Sudan:211,ES:Spain:34,LK:Sri Lanka:94,SD:Sudan:249,SR:Suriname:597,' +
    'SE:Sweden:46,CH:Switzerland:41,SY:Syria:963,TW:Taiwan:886,TJ:Tajikistan:992,' +
    'TZ:Tanzania:255,TH:Thailand:66,TL:Timor-Leste:670,TG:Togo:228,TO:Tonga:676,' +
    'TT:Trinidad and Tobago:1868,TN:Tunisia:216,TR:Turkiye:90,TM:Turkmenistan:993,' +
    'TV:Tuvalu:688,UG:Uganda:256,UA:Ukraine:380,AE:United Arab Emirates:971,' +
    'GB:United Kingdom:44,US:United States:1,UY:Uruguay:598,UZ:Uzbekistan:998,' +
    'VU:Vanuatu:678,VA:Vatican City:379,VE:Venezuela:58,VN:Vietnam:84,YE:Yemen:967,' +
    'ZM:Zambia:260,ZW:Zimbabwe:263';

  function flagOf(code) {
    return String.fromCodePoint.apply(String, code.toUpperCase().split('').map(function (c) {
      return 0x1F1E6 + c.charCodeAt(0) - 65;
    }));
  }

  var LIST = PACKED.split(',').map(function (row) {
    var p = row.split(':');
    return {
      code: p[0],
      name: p[1],
      dial: '+' + p[2],
      flag: flagOf(p[0]),
      search: (p[0] + ' ' + p[1] + ' +' + p[2]).toLowerCase()
    };
  }).sort(function (a, b) { return a.name.localeCompare(b.name); });

  var BY_CODE = Object.create(null);
  LIST.forEach(function (c) { BY_CODE[c.code] = c; });

  /* ------------------------------------------------------- phone validation

     A mobile number is only valid RELATIVE TO A COUNTRY. This used to be one
     regex — six to fourteen digits, country ignored — which is wrong in both
     directions: it accepted 8608979020 as a United States number and it had no
     opinion at all about Singapore's eight digits or the UAE's nine.

     libphonenumber-js carries Google's own per-country metadata, so the rules
     come from the same source every telecom uses rather than from a list of
     digit counts someone guessed and nobody maintains.

     IT IS LOADED LAZILY AND IS NEVER REQUIRED. Most visits never open the
     sign-up form, it is ~175 KB, and — more importantly — a sign-up must not
     become impossible because a CDN is slow or blocked. Until it arrives, and
     for ever if it never does, the fallback below applies the only rule that
     holds everywhere: E.164 allows at most 15 digits including the country
     code, and no national number is shorter than four. That is permissive on
     purpose. Refusing a real shop's real number is a worse failure than
     accepting a typo the payment gateway will reject a moment later. */

  var LIB_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/libphonenumber-js/1.11.4/libphonenumber-js.min.js';
  var libLoad = null;
  var lib = null;
  var libListeners = [];

  function digitsOf(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }

  function loadValidator() {
    if (lib) return Promise.resolve(lib);
    if (libLoad) return libLoad;
    if (typeof document === 'undefined') return Promise.resolve(null);

    libLoad = new Promise(function (resolve) {
      var el = document.createElement('script');
      el.src = LIB_SRC;
      el.async = true;
      el.onload = function () {
        lib = global.libphonenumber || null;
        resolve(lib);
        /* Validation just got stricter than it was a moment ago, so anything
           showing a validity state needs to look again. */
        var waiting = libListeners; libListeners = [];
        waiting.forEach(function (fn) { try { fn(lib); } catch (e) { /* never break a form */ } });
      };
      el.onerror = function () {
        libLoad = null;                       /* a later attempt may succeed */
        resolve(null);                        /* NOT a rejection: the fallback stands */
      };
      document.head.appendChild(el);
    });
    return libLoad;
  }

  SM.countries = {
    all: LIST,
    byCode: function (code) { return BY_CODE[code] || null; },
    search: function (q) {
      q = (q || '').toLowerCase().trim();
      if (!q) return LIST;
      var starts = [], has = [];
      LIST.forEach(function (c) {
        var n = c.name.toLowerCase();
        if (n.indexOf(q) === 0) starts.push(c);
        else if (c.search.indexOf(q) > -1) has.push(c);
      });
      return starts.concat(has);
    },

    /** Starts the metadata download. Safe to call repeatedly. */
    preloadValidator: loadValidator,

    /** Called once the metadata lands, so a form can re-check what it drew. */
    onValidatorReady: function (fn) {
      if (lib) { fn(lib); return; }
      libListeners.push(fn);
      loadValidator();
    },

    /** True once the real per-country rules are in force. */
    validatorReady: function () { return !!lib; },

    /**
     * Is this a valid mobile number for that country?
     *
     * @param {string} countryCode ISO alpha-2, e.g. "IN"
     * @param {string} input       what the user typed, in national form
     */
    validNumber: function (countryCode, input) {
      var digits = digitsOf(input);
      if (!digits) return false;

      if (lib && countryCode && BY_CODE[countryCode]) {
        try {
          var parsed = lib.parsePhoneNumberFromString(digits, countryCode);
          return !!(parsed && parsed.isValid());
        } catch (e) {
          /* Unknown region or malformed input — fall through to the length
             check rather than failing the form on a library edge case. */
        }
      }
      return digits.length >= 4 && digits.length <= 15;
    },

    /**
     * The number in E.164, or '' when it cannot be formed.
     * Falls back to dial code + digits, which is what E.164 is.
     */
    toE164: function (countryCode, input) {
      var digits = digitsOf(input);
      if (!digits) return '';

      if (lib && countryCode && BY_CODE[countryCode]) {
        try {
          var parsed = lib.parsePhoneNumberFromString(digits, countryCode);
          if (parsed && parsed.number) return parsed.number;
        } catch (e) { /* fall through */ }
      }
      var c = BY_CODE[countryCode];
      return c && c.dial ? '+' + digitsOf(c.dial) + digits : '';
    },

    /** Digits only, as typed — what gets stored as the national number. */
    nationalDigits: digitsOf
  };
})(window);

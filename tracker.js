(function() {
    // 1. Haal de configuratie op via de BackendAgency namespace
    var config = window.BackendAgencyConfig || {};
    var measurementId = config.measurementId;
    var tenantId = config.tenantId;
    var serverBaseUrl = config.serverBaseUrl || 'https://api.backend-agency.com/';
    // Wat te doen op sites zonder (Google) Consent Mode: 'granted' (standaard, zoals voorheen) of 'denied'.
    var consentFallback = config.consentDefault === 'denied' ? 'denied' : 'granted';

    // Stop het script als de ID's ontbreken
    if (!measurementId || !tenantId) {
        console.warn('BackendAgency Tracker: Missing measurementId or tenantId');
        return;
    }

    // Niet twee keer laden: anders wordt dataLayer.push dubbel ingepakt en gaat elk event 2x weg.
    if (window.__backendAgencyTrackerLoaded) return;
    window.__backendAgencyTrackerLoaded = true;

    var isDebug = window.location.search.indexOf('gtm_debug=1') > -1;
    var sentObjects = [];
    var lastEventTime = Date.now();
    var isPaused = false;

    var COOKIE_CID = '_backendagency_cid';
    var COOKIE_SID = '_backendagency_sess_id';
    var COOKIE_SCT = '_backendagency_sess_count';
    var TWO_YEARS_MIN = 1051200;
    var COOKIE_OPPREF = '_backendagency_oppref';
    var THIRTY_DAYS_MIN = 43200;

    // =====================================================================
    // HELPERS
    // =====================================================================

    // Zet een bedrag om naar een getal. Kan om met getallen en met strings zoals
    // "49.95", "49,95", "€ 1.234,56", "1,234.56" en "EUR 12,-".
    // Geeft null terug als er geen bruikbaar bedrag in zit.
    function parseAmount(n) {
        if (n === null || n === undefined || n === '') return null;
        if (typeof n === 'number') return isFinite(n) ? n : null;
        if (typeof n !== 'string') return null;

        var s = n.replace(/[^0-9,.\-]/g, '');      // valuta, spaties en tekst eruit
        s = s.replace(/[,.]-$/, '');                // "12,-" -> "12"
        if (!/[0-9]/.test(s)) return null;

        var lastComma = s.lastIndexOf(',');
        var lastDot = s.lastIndexOf('.');

        if (lastComma > -1 && lastDot > -1) {
            // Beide aanwezig: de laatste is het decimaalteken, de andere is duizendtal-scheiding
            if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
            else s = s.replace(/,/g, '');
        } else if (lastComma > -1) {
            // Alleen komma's: één komma = decimaal (NL), meerdere = duizendtallen
            s = (s.indexOf(',') === lastComma) ? s.replace(',', '.') : s.replace(/,/g, '');
        } else if (lastDot > -1 && s.indexOf('.') !== lastDot) {
            // Meerdere punten: duizendtal-scheiding ("1.234.567")
            s = s.replace(/\./g, '');
        }

        var num = parseFloat(s);
        return isNaN(num) ? null : num;
    }

    // Eerste waarde die echt gevuld is (0 telt wel mee, null/undefined/'' niet)
    function firstDefined() {
        for (var i = 0; i < arguments.length; i++) {
            var a = arguments[i];
            if (a !== null && a !== undefined && a !== '') return a;
        }
        return null;
    }

    function findKey(obj, key, depth) {
      depth = depth || 0;
      if (depth > 5) return null;
      if (!obj || typeof obj !== 'object') return null;
      if (typeof obj.nodeType !== 'undefined' || obj === window) return null;
      if (obj[key] !== undefined) return obj[key];

      for (var k in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, k) && typeof obj[k] === 'object') {
          var found = findKey(obj[k], key, depth + 1);
          if (found !== null) return found;
        }
      }
      return null;
    }

    // Alleen echte getallen als numerieke parameter (epn.) versturen.
    // Strings met voorloopnul ("00123", "0612345678") of extreem lang blijven tekst.
    function isNumericValue(v) {
        if (typeof v === 'number') return isFinite(v);
        if (typeof v !== 'string') return false;
        return /^-?(0|[1-9][0-9]{0,14})(\.[0-9]+)?$/.test(v);
    }

    // --- PERSOONSGEGEVENS (PII) FILTER ---
    var PII_KEYS = [
        'email', 'mail', 'emailaddress', 'customeremail', 'useremail', 'billingemail',
        'phone', 'phonenumber', 'telephone', 'telefoon', 'telefoonnummer', 'tel', 'mobile', 'mobiel', 'mobilenumber',
        'firstname', 'lastname', 'fullname', 'voornaam', 'achternaam',
        'street', 'straat', 'address', 'adres', 'streetaddress', 'billingaddress', 'shippingaddress',
        'postcode', 'postalcode', 'zip', 'zipcode', 'password', 'wachtwoord', 'iban', 'bsn', 'ssn',
        'birthdate', 'dateofbirth', 'geboortedatum', 'dob', 'userdata', 'ip', 'ipaddress'
    ];
    var EMAIL_RE = /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i;
    var EMAIL_RE_G = /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi;

    function isPiiKey(key) {
        var n = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
        return PII_KEYS.indexOf(n) > -1 || n.indexOf('email') > -1 || n.indexOf('phone') > -1 || n.indexOf('password') > -1;
    }

    function redactString(s) {
        return String(s)
            .replace(EMAIL_RE_G, '[email]')
            .replace(/^tel:.*$/i, 'tel:[redacted]');
    }

    function safeDecode(s) {
        try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch (e) { return String(s); }
    }

    // Haalt e-mailadressen en PII-parameters uit een URL (querystring en hash)
    function sanitizeUrl(url) {
        if (!url) return url;
        var hashIdx = url.indexOf('#');
        var hash = hashIdx > -1 ? url.substring(hashIdx) : '';
        var rest = hashIdx > -1 ? url.substring(0, hashIdx) : url;
        var qIdx = rest.indexOf('?');
        if (qIdx > -1) {
            var base = rest.substring(0, qIdx);
            var query = rest.substring(qIdx + 1).split('&').map(function(pair) {
                if (!pair) return pair;
                var eq = pair.indexOf('=');
                var k = eq > -1 ? pair.substring(0, eq) : pair;
                var v = eq > -1 ? pair.substring(eq + 1) : '';
                if (isPiiKey(safeDecode(k)) || EMAIL_RE.test(safeDecode(v))) return k + '=%5Bredacted%5D';
                return pair;
            }).join('&');
            rest = base + '?' + query;
        }
        if (hash && EMAIL_RE.test(safeDecode(hash))) hash = '#[redacted]';
        return redactString(rest) + hash;
    }

    function cleanValue(v) {
        if (typeof v !== 'string') return v;
        return /^https?:\/\//i.test(v) ? sanitizeUrl(v) : redactString(v);
    }

    // --- STORAGE HELPERS (veilig, browsers kunnen dit blokkeren) ---
    function storageGet(type, key) {
        try { return window[type].getItem(key); } catch (e) { return null; }
    }
    function storageSet(type, key, value) {
        try { window[type].setItem(key, value); } catch (e) {}
    }

    // --- COOKIE HELPERS ---
    function writeCookie(name, value, expires, domainAttr) {
      document.cookie = name + "=" + (value || "") + expires + "; path=/" + domainAttr + "; SameSite=Lax";
    }

    function setCookie(name, value, minutes) {
      var expires = "";
      if (minutes) {
        var date = new Date();
        date.setTime(date.getTime() + (minutes * 60 * 1000));
        expires = "; expires=" + date.toUTCString();
      }
      var domain = location.hostname.replace(/^www\./i, "");
      writeCookie(name, value, expires, "; domain=." + domain);
      // Lukt een cookie op het hoofddomein niet (bijv. IP-adres of afwijkend domein),
      // dan alleen op deze host proberen.
      if (getCookie(name) !== String(value || "")) writeCookie(name, value, expires, "");
    }

    function getCookie(name) {
      var nameEQ = name + "=";
      var ca = document.cookie.split(';');
      for(var i=0;i < ca.length;i++) {
        var c = ca[i];
        while (c.charAt(0)==' ') c = c.substring(1,c.length);
        if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length,c.length);
      }
      return null;
    }

    function deleteCookie(name) {
      var domain = location.hostname.replace(/^www\./i, "");
      var past = "; expires=Thu, 01 Jan 1970 00:00:00 GMT";
      writeCookie(name, "", past, "; domain=." + domain);
      writeCookie(name, "", past, "");
    }

    // Kan dit script cookies schrijven én teruglezen? (Eén keer per pagina getest.)
    // Zo niet, dan zou elk event een nieuwe sessie lijken: dan anoniem meten.
    var cookiesOk = null;
    function cookiesWritable() {
      if (cookiesOk !== null) return cookiesOk;
      try {
        var probe = '_backendagency_ck';
        setCookie(probe, '1', 1);
        cookiesOk = getCookie(probe) === '1';
        deleteCookie(probe);
      } catch (e) {
        cookiesOk = false;
      }
      return cookiesOk;
    }

    // =====================================================================
    // CONSENT
    // =====================================================================
    // Leest Google Consent Mode uit. Bron 1: de consentstatus die GTM bijhoudt
    // (werkt ook voor CMP-templates in GTM). Bron 2: gtag('consent', ...) commando's
    // in de dataLayer. Zonder Consent Mode op de site geldt consentFallback.
    var dlConsent = { detected: false };

    function applyConsentCommand(obj) {
        if (!obj || typeof obj !== 'object' || obj[0] !== 'consent') return false;
        var mode = obj[1];
        var settings = obj[2];
        if ((mode !== 'default' && mode !== 'update') || !settings || typeof settings !== 'object') return true;
        dlConsent.detected = true;
        ['ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization'].forEach(function(k) {
            var v = settings[k];
            if (v !== 'granted' && v !== 'denied') return;
            if (mode === 'update') {
                dlConsent[k] = v;
            } else if (!dlConsent['updated_' + k]) {
                // Meerdere defaults (bijv. per regio): 'denied' wint, we weten de regio niet
                if (v === 'denied' || !dlConsent[k]) dlConsent[k] = v;
            }
            if (mode === 'update') dlConsent['updated_' + k] = true;
        });
        return true;
    }

    function readGtmConsent(key) {
        try {
            var entries = window.google_tag_data && window.google_tag_data.ics && window.google_tag_data.ics.entries;
            var e = entries && entries[key];
            if (!e) return null;
            var v = (e.update !== undefined) ? e.update : e['default'];
            return v === true ? 'granted' : (v === false ? 'denied' : null);
        } catch (err) { return null; }
    }

    function consentValue(key) {
        return readGtmConsent(key) || dlConsent[key] || null;
    }

    function consentDetected() {
        return dlConsent.detected || readGtmConsent('analytics_storage') !== null;
    }

    function isGranted(key) {
        var v = consentValue(key);
        if (v) return v === 'granted';
        return consentFallback === 'granted';
    }

    // =====================================================================
    // CLIENT ID & SESSIE BEHEER
    // =====================================================================
    // Met analytics-toestemming: vaste cookies (zoals voorheen).
    // Zonder toestemming: geen cookies, alleen een tijdelijke ID voor deze pagina.
    var pageLoadId = Math.floor(Date.now() / 1000).toString();
    var tempClientId = Math.random().toString(36).substring(2) + '.' + pageLoadId;
    var usedCookies = false;
    var pendingSessionStart = false;
    var pendingFirstVisit = false;

    function anonymousIdentity() {
        pendingSessionStart = false;
        pendingFirstVisit = false;
        return { cid: tempClientId, sid: pageLoadId, sct: '1', persistent: false };
    }

    function getIdentity() {
        if (!isGranted('analytics_storage')) {
            if (usedCookies) {
                // Toestemming ingetrokken: eigen cookies opruimen
                deleteCookie(COOKIE_CID); deleteCookie(COOKIE_SID); deleteCookie(COOKIE_SCT);
                usedCookies = false;
            }
            return anonymousIdentity();
        }

        // Toestemming, maar cookies werken niet (geblokkeerd of niet te zetten)
        if (!cookiesWritable()) return anonymousIdentity();

        usedCookies = true;

        var cid = getCookie(COOKIE_CID);
        if (!cid) {
            var match = document.cookie.match(/(?:^|; )_ga=([^;]*)/);
            if (match) {
                var parts = match[1].split('.');
                if (parts.length >= 4) cid = parts[2] + '.' + parts[3];
            }
            if (!cid) cid = tempClientId;
            setCookie(COOKIE_CID, cid, TWO_YEARS_MIN);
        }

        var sid = getCookie(COOKIE_SID);
        var sct;
        if (!sid) {
            // Nieuwe sessie (eerste bezoek, of > 30 min geen activiteit)
            sid = Math.floor(Date.now() / 1000).toString();
            sct = (parseInt(getCookie(COOKIE_SCT) || "0", 10) + 1).toString();
            setCookie(COOKIE_SCT, sct, TWO_YEARS_MIN);
            pendingSessionStart = true;
            pendingFirstVisit = (sct === "1");
        } else {
            sct = getCookie(COOKIE_SCT) || "1";
        }
        setCookie(COOKIE_SID, sid, 30); // Verleng sessie bij elk event

        return { cid: cid, sid: sid, sct: sct, persistent: true };
    }

    // =====================================================================
    // CHATGPT ADS KLIK-ID (oppref)
    // =====================================================================
    // ChatGPT Ads zet ?oppref=... op de landingspagina. Met advertentie-toestemming
    // bewaren we die 30 dagen in een eigen cookie, zodat een latere aankoop aan de
    // klik gekoppeld kan worden. Zonder toestemming: niet bewaren, oude cookie weg.
    function getUrlParam(name) {
        var q = window.location.search.substring(1).split('&');
        for (var i = 0; i < q.length; i++) {
            var eq = q[i].indexOf('=');
            var k = eq > -1 ? q[i].substring(0, eq) : q[i];
            if (k === name) return eq > -1 ? q[i].substring(eq + 1) : '';
        }
        return null;
    }

    function rawDecode(s) {
        try { return decodeURIComponent(s); } catch (e) { return s; }
    }

    function getOppref() {
        var fromUrl = getUrlParam('oppref');
        fromUrl = fromUrl ? rawDecode(fromUrl) : null;
        if (!isGranted('ad_storage')) {
            if (getCookie(COOKIE_OPPREF)) deleteCookie(COOKIE_OPPREF);
            return fromUrl;
        }
        if (fromUrl) {
            if (cookiesWritable()) setCookie(COOKIE_OPPREF, encodeURIComponent(fromUrl), THIRTY_DAYS_MIN);
            return fromUrl;
        }
        var stored = getCookie(COOKIE_OPPREF);
        return stored ? rawDecode(stored) : null;
    }

    document.addEventListener('visibilitychange', function() {
        isPaused = document.hidden;
        if(!isPaused) lastEventTime = Date.now();
    });

    // =====================================================================
    // DUBBELE AANKOPEN TEGENGAAN
    // =====================================================================
    // Een purchase met hetzelfde transaction_id wordt maar één keer verstuurd
    // (ook na herladen van de bedankpagina of later openen via de bevestigingsmail).
    var TX_STORAGE_KEY = '_backendagency_tx';
    var TX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    var txMemory = [];

    function isDuplicatePurchase(tid) {
        var id = String(tid);
        if (txMemory.indexOf(id) > -1) return true;

        // Met toestemming localStorage (blijvend), anders alleen sessionStorage
        var type = isGranted('analytics_storage') ? 'localStorage' : 'sessionStorage';
        var now = Date.now();
        var list = [];
        try { list = JSON.parse(storageGet(type, TX_STORAGE_KEY) || '[]') || []; } catch (e) { list = []; }
        if (!Array.isArray(list)) list = [];
        list = list.filter(function(x) { return x && x.id && (now - x.t) < TX_TTL_MS; });

        for (var i = 0; i < list.length; i++) {
            if (list[i].id === id) return true;
        }

        txMemory.push(id);
        list.push({ id: id, t: now });
        storageSet(type, TX_STORAGE_KEY, JSON.stringify(list.slice(-50)));
        return false;
    }

    // =====================================================================
    // ITEMS NAAR GA4-FORMAAT (pr1=id...~nm...~pr...)
    // =====================================================================
    var MAX_ITEMS = 200; // GA4-limiet per event
    var ITEM_FIELDS = [
        ['id', ['item_id', 'id', 'item_sku', 'sku', 'magento_sku']],
        ['nm', ['item_name', 'name']],
        ['af', ['affiliation']],
        ['cp', ['coupon']],
        ['ds', ['discount'], 'num'],
        ['lp', ['index', 'position'], 'int'],
        ['br', ['item_brand', 'brand']],
        ['ca', ['item_category', 'category']],
        ['c2', ['item_category2']],
        ['c3', ['item_category3']],
        ['c4', ['item_category4']],
        ['c5', ['item_category5']],
        ['li', ['item_list_id']],
        ['ln', ['item_list_name', 'list']],
        ['va', ['item_variant', 'variant']],
        ['pr', ['price'], 'num'],
        ['qt', ['quantity'], 'int']
    ];

    function encodeItem(item) {
        if (!item || typeof item !== 'object') return null;
        var parts = [];
        ITEM_FIELDS.forEach(function(f) {
            var raw = null;
            for (var i = 0; i < f[1].length && raw === null; i++) raw = firstDefined(item[f[1][i]]);
            if (raw === null || typeof raw === 'object') return;
            var out;
            if (f[2] === 'num') {
                out = parseAmount(raw);
                if (out === null) return;
            } else if (f[2] === 'int') {
                out = parseInt(raw, 10);
                if (isNaN(out)) return;
            } else {
                out = encodeURIComponent(String(raw).replace(/~/g, '-'));
            }
            parts.push(f[0] + out);
        });
        return parts.length ? parts.join('~') : null;
    }

    // =====================================================================
    // HOOFD VERZEND FUNCTIE
    // =====================================================================
    var ECOMMERCE_EVENTS = ['purchase', 'refund', 'begin_checkout', 'add_payment_info', 'add_shipping_info',
        'add_to_cart', 'remove_from_cart', 'view_cart', 'view_item', 'view_item_list', 'select_item',
        'add_to_wishlist', 'view_promotion', 'select_promotion'];

    function sendToSgtm(data) {
      if (!data || !data.event) return;

      // Hetzelfde dataLayer-object nooit twee keer verwerken
      if (sentObjects.indexOf(data) > -1) return;
      sentObjects.push(data);

      // GTM's eigen events: alleen paginaweergaven doorlaten. Klikken, scrolls en
      // formulieren meet dit script zelf; gtm.linkClick/gtm.scroll/gtm.formSubmit zouden
      // dubbel tellen, en gtm.dom/gtm.load/gtm.init/gtm.timer e.d. zijn ruis.
      var eventMap = {
        'gtm.js': 'page_view',
        'gtm.historyChange': 'page_view',
        'gtm.historyChange-v2': 'page_view'
      };
      var eventName = eventMap[data.event] || data.event;
      if (!eventMap[data.event] && String(data.event).indexOf('gtm.') === 0) return;

      // --- ECOMMERCE WAARDEN ---
      var ecommerceObj = (data.ecommerce && typeof data.ecommerce === 'object') ? data.ecommerce : {};
      var uaPurchase = (ecommerceObj.purchase && typeof ecommerceObj.purchase === 'object') ? ecommerceObj.purchase : {};
      var uaActionField = (uaPurchase.actionField && typeof uaPurchase.actionField === 'object') ? uaPurchase.actionField : {};

      var tid = firstDefined(
          data.transaction_id, ecommerceObj.transaction_id, uaPurchase.transaction_id, uaActionField.id,
          data.transactionId, ecommerceObj.transactionId
      );
      var isEcommerce = !!data.ecommerce || tid !== null || ECOMMERCE_EVENTS.indexOf(eventName) > -1;
      // Diep zoeken alleen bij ecommerce-events, zodat een willekeurig 'value'-veld
      // in een ander event niet als omzet wordt meegestuurd.
      if (tid === null && isEcommerce) tid = firstDefined(findKey(data, 'transaction_id'), findKey(data, 'transactionId'));

      if (eventName === 'purchase' && tid !== null && isDuplicatePurchase(tid)) {
          if (isDebug) console.warn('BackendAgency Tracker: dubbele purchase overgeslagen:', tid);
          return;
      }

      // GA4 (value), UA enhanced (actionField.revenue), UA standaard (transactionTotal)
      // en veelgebruikte shop-plugin varianten.
      var rawVal = firstDefined(
          ecommerceObj.value, data.value, uaPurchase.value,
          uaActionField.revenue, ecommerceObj.revenue, data.revenue,
          data.transactionTotal, ecommerceObj.transactionTotal,
          data.transaction_total, data.order_total, data.orderTotal, data.order_value
      );
      if (rawVal === null && isEcommerce) {
          rawVal = firstDefined(findKey(data, 'value'), findKey(data, 'revenue'), findKey(data, 'transactionTotal'));
      }
      var val = parseAmount(rawVal);

      var cur = firstDefined(
          ecommerceObj.currency, data.currency, uaPurchase.currency,
          ecommerceObj.currencyCode, data.currencyCode, data.transactionCurrency,
          isEcommerce ? findKey(data, 'currency') : null, 'EUR'
      );
      cur = String(cur).trim().toUpperCase();

      var coupon = firstDefined(ecommerceObj.coupon, uaActionField.coupon, data.coupon);
      var affiliation = firstDefined(ecommerceObj.affiliation, uaActionField.affiliation, data.affiliation);
      var shipping = parseAmount(firstDefined(ecommerceObj.shipping, uaActionField.shipping, data.shipping, data.transactionShipping));
      var tax = parseAmount(firstDefined(ecommerceObj.tax, uaActionField.tax, data.tax, data.transactionTax));

      // --- BASIS PARAMETERS ---
      var identity = getIdentity();

      var params = [
        'v=2', 'tid=' + measurementId, 'cid=' + encodeURIComponent(identity.cid),
        'sid=' + identity.sid, 'sct=' + identity.sct, 'en=' + encodeURIComponent(eventName),
        'dl=' + encodeURIComponent(sanitizeUrl(window.location.href)),
        'dr=' + encodeURIComponent(sanitizeUrl(document.referrer || '')),
        'ul=' + (navigator.language || 'nl-nl').toLowerCase(), 'seg=1'
      ];

      // Sessiedata ook als event parameters, zodat BQ deze direct pakt
      params.push('ep.ga_session_id=' + encodeURIComponent(identity.sid));
      params.push('epn.ga_session_number=' + encodeURIComponent(identity.sct));
      // Geen vaste ID (geen toestemming of geen cookies): de server voegt deze hits samen
      if (!identity.persistent) params.push('ep.ba_anon=1');

      if (isDebug) params.push('_dbg=1');

      // Sessiestart / eerste bezoek alleen op het eerste event van een nieuwe sessie
      if (pendingSessionStart) {
          params.push('_ss=1');
          if (pendingFirstVisit) params.push('_fv=1');
          pendingSessionStart = false;
          pendingFirstVisit = false;
      }

      // Consent Mode status voor sGTM (G1 + ad_storage + analytics_storage)
      var hasConsentMode = consentDetected();
      if (hasConsentMode) {
          params.push('gcs=G1' + (isGranted('ad_storage') ? '1' : '0') + (isGranted('analytics_storage') ? '1' : '0'));
      }

      var engagementTime = isPaused ? 0 : (Date.now() - lastEventTime);
      if (engagementTime > 0 && engagementTime < 1800000) params.push('_et=' + engagementTime);

      params.push('ep.tenant_id=' + encodeURIComponent(tenantId));

      // ChatGPT Ads klik-ID voor de server-tag (OpenAI Conversions API)
      var oppref = getOppref();
      if (oppref) params.push('ep.oppref=' + encodeURIComponent(oppref));

      if (tid !== null) params.push('ep.transaction_id=' + encodeURIComponent(tid));
      if (val !== null) {
          params.push('epn.value=' + val);
      } else if (rawVal !== null && isDebug) {
          console.warn('BackendAgency Tracker: kon transactiewaarde niet lezen:', rawVal);
      }
      if (cur) params.push('cu=' + encodeURIComponent(cur));
      if (coupon !== null && typeof coupon !== 'object') params.push('ep.coupon=' + encodeURIComponent(coupon));
      if (affiliation !== null && typeof affiliation !== 'object') params.push('ep.affiliation=' + encodeURIComponent(affiliation));
      if (shipping !== null) params.push('epn.shipping=' + shipping);
      if (tax !== null) params.push('epn.tax=' + tax);

      // --- ITEM EXTRACTIE ---
      var items = null;
      if (Array.isArray(ecommerceObj.items)) {
          items = ecommerceObj.items;
      } else if (Array.isArray(data.items)) {
          items = data.items;
      } else if (Array.isArray(uaPurchase.products)) {
          items = uaPurchase.products;
      } else if (Array.isArray(data.transactionProducts)) {
          items = data.transactionProducts;
      } else if (isEcommerce) {
          items = findKey(data, 'items');
      }

      if (!items && data.eventSettingsTable && Array.isArray(data.eventSettingsTable)) {
        for (var k = 0; k < data.eventSettingsTable.length; k++) {
          if (data.eventSettingsTable[k].parameter === 'items') {
            items = data.eventSettingsTable[k].parameterValue;
            break;
          }
        }
      }

      if (Array.isArray(items)) {
          var n = 0;
          for (var ii = 0; ii < items.length && n < MAX_ITEMS; ii++) {
              var enc = encodeItem(items[ii]);
              if (enc) { n++; params.push('pr' + n + '=' + enc); }
          }
      }

      // --- DUAL TRACKING: GA4 (PLAT) + BIGQUERY (extra_data JSON) ---
      var skip = ['event', 'gtm', 'ecommerce', 'eventModel', 'items', 'eventCallback', 'eventTimeout', 'eventSettingsTable', 'user', 'breadcrumb', 'debug_firestore_test'];
      // Al hierboven genormaliseerd verstuurd; niet nog een keer als ruwe parameter
      // (een dubbele 'value' zou de numerieke epn.value overschrijven).
      var handled = ['value', 'currency', 'transaction_id', 'coupon', 'affiliation', 'shipping', 'tax'];
      var bqData = {};

      bqData.ga_session_id = identity.sid;
      bqData.ga_session_number = identity.sct;
      if (!identity.persistent) bqData.ba_anon = '1';
      if (tid !== null) bqData.transaction_id = tid;
      if (val !== null) bqData.value = val;
      if (cur) bqData.currency = cur;
      if (coupon !== null && typeof coupon !== 'object') bqData.coupon = coupon;
      if (affiliation !== null && typeof affiliation !== 'object') bqData.affiliation = affiliation;
      if (shipping !== null) bqData.shipping = shipping;
      if (tax !== null) bqData.tax = tax;
      if (hasConsentMode) {
          bqData.consent_analytics_storage = isGranted('analytics_storage') ? 'granted' : 'denied';
          bqData.consent_ad_storage = isGranted('ad_storage') ? 'granted' : 'denied';
      }

      for (var key in data) {
        if (Object.prototype.hasOwnProperty.call(data, key) && skip.indexOf(key) === -1 && handled.indexOf(key) === -1) {
          var v = data[key];
          if (v === null || typeof v === 'object' || typeof v === 'function') continue;
          // Persoonsgegevens (e-mail, telefoon, naam, adres, ...) nooit meesturen
          if (isPiiKey(key)) continue;
          v = cleanValue(v);
          params.push((isNumericValue(v) ? 'epn.' : 'ep.') + key + '=' + encodeURIComponent(v));
          bqData[key] = v;
        }
      }

      if (Array.isArray(items) && items.length > 0) {
          try {
              bqData.items = JSON.stringify(items);
          } catch (e) {
              bqData.items = '[]';
          }
      }

      var safeExtraData = "{}";
      try {
          safeExtraData = JSON.stringify(bqData);
      } catch (e) {
          safeExtraData = '{"error": "circular_reference_avoided"}';
      }
      params.push('ep.extra_data=' + encodeURIComponent(safeExtraData));

      // --- VERZENDING ---
      var fullUrl = serverBaseUrl.replace(/\/$/, "") + '/g/collect?' + params.join('&');

      if (navigator.sendBeacon) {
          navigator.sendBeacon(fullUrl);
      } else if (window.fetch) {
          fetch(fullUrl, { method: 'GET', mode: 'no-cors', keepalive: true });
      } else {
          try {
              var xhr = new XMLHttpRequest();
              xhr.open('GET', fullUrl, true);
              xhr.send();
          } catch (e) {}
      }
      lastEventTime = Date.now();
    }

    function safePush(obj) {
        try { window.dataLayer.push(obj); } catch (err) {}
    }

    // =====================================================================
    // AUTO-TRACKERS
    // =====================================================================

    // --- YOUTUBE (API alleen laden als er een YouTube-video op de pagina staat) ---
    var YT_SRC = /youtube(-nocookie)?\.com/i;

    var existingYTReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function() {
        if (typeof existingYTReady === 'function') {
            existingYTReady();
        }
        var frames = document.getElementsByTagName('iframe');
        for (var i = 0; i < frames.length; i++) {
            if (YT_SRC.test(frames[i].src || '')) {
                new YT.Player(frames[i], { events: { 'onStateChange': function(e) {
                    var s = { '0': 'video_complete', '1': 'video_start' };
                    if (s[e.data]) {
                        try {
                            window.dataLayer.push({ event: s[e.data], video_title: e.target.getVideoData().title });
                        } catch(err) {}
                    }
                }}});
            }
        }
    };

    var ytRequested = false;
    function maybeLoadYouTubeApi() {
        if (ytRequested) return;
        var frames = document.getElementsByTagName('iframe');
        var found = false;
        for (var i = 0; i < frames.length; i++) {
            if (YT_SRC.test(frames[i].src || '')) { found = true; break; }
        }
        if (!found) return;
        ytRequested = true;
        if (typeof YT === 'undefined' || typeof YT.Player === 'undefined') {
            var ytTag = document.createElement('script');
            ytTag.src = "https://www.youtube.com/iframe_api";
            (document.head || document.documentElement).appendChild(ytTag);
        }
    }
    maybeLoadYouTubeApi();
    document.addEventListener('DOMContentLoaded', maybeLoadYouTubeApi);
    window.addEventListener('load', maybeLoadYouTubeApi);

    // --- KLIKKEN ---
    document.addEventListener('click', function(e) {
        var a = e.target;
        while (a && a.tagName !== 'A' && a.nodeType === 1) {
            a = a.parentNode;
        }

        if (!a || !a.href) return;
        var isExternal = a.hostname !== window.location.hostname;
        if (isExternal) safePush({ event: 'click', outbound: true, link_url: a.href });
        else safePush({ event: 'click', link_url: a.href, link_text: String(a.innerText || '').trim().substring(0, 100) });
    }, true);

    // --- FORMULIEREN ---
    // form_abandonment: alleen formulieren waarin iets is ingevuld en die niet zijn
    // verstuurd, één keer per formulier, op het moment dat de bezoeker de pagina verlaat.
    var formStates = [];

    function getFormState(form) {
        for (var i = 0; i < formStates.length; i++) {
            if (formStates[i].form === form) return formStates[i];
        }
        var st = { form: form, touched: false, submitted: false, reported: false, lastField: 'unknown' };
        formStates.push(st);
        return st;
    }

    function formIdOf(form) {
        if (!form) return 'no_form';
        return form.id || form.getAttribute('name') || 'form';
    }

    function onFieldChange(e) {
        var t = e.target;
        if (!t || ['INPUT', 'SELECT', 'TEXTAREA'].indexOf(t.tagName) === -1) return;
        if (t.type === 'hidden' || t.type === 'submit' || t.type === 'button') return;
        var st = getFormState(t.form || null);
        st.touched = true;
        st.lastField = t.id || t.name || 'unknown';
    }
    document.addEventListener('input', onFieldChange, true);
    document.addEventListener('change', onFieldChange, true);

    document.addEventListener('submit', function(e) {
        var st = getFormState(e.target);
        st.submitted = true;
        safePush({ event: 'form_submit', form_id: formIdOf(e.target) });
    }, true);

    window.addEventListener('pagehide', function() {
        formStates.forEach(function(st) {
            if (st.touched && !st.submitted && !st.reported) {
                st.reported = true;
                safePush({ event: 'form_abandonment', form_id: formIdOf(st.form), field_id: st.lastField });
            }
        });
    });

    // --- SCROLL ---
    var sc = [25, 50, 75, 90];
    window.addEventListener('scroll', function() {
        var scrollable = document.documentElement.scrollHeight - document.documentElement.clientHeight;
        if (scrollable <= 0) return;
        var p = (document.documentElement.scrollTop || document.body.scrollTop) / scrollable * 100;
        sc = sc.filter(function(s) {
            if (p > s) {
                safePush({ event: 'scroll', percent_scrolled: s });
                return false;
            }
            return true;
        });
    }, {passive: true});

    // =====================================================================
    // INITIALISATIE
    // =====================================================================
    function handleEntry(obj, label) {
        if (!obj || typeof obj !== 'object') return;
        try {
            if (applyConsentCommand(obj)) return;
            if (obj.event) sendToSgtm(obj);
        } catch (error) {
            console.error("BackendAgency Tracker waarschuwing - " + label + ":", error);
        }
    }

    if (!window.dataLayer) window.dataLayer = [];
    var originalPush = window.dataLayer.push;

    window.dataLayer.push = function() {
      var args = Array.prototype.slice.call(arguments);
      args.forEach(function(obj) { handleEntry(obj, 'dataLayer afhandeling'); });
      return originalPush.apply(window.dataLayer, arguments);
    };

    window.dataLayer.forEach(function(obj) { handleEntry(obj, 'initiële afhandeling'); });

})();

(function() {
    // 1. Haal de configuratie op via de nieuwe BackendAgency namespace
    var config = window.BackendAgencyConfig || {};
    var measurementId = config.measurementId;
    var tenantId = config.tenantId;
    var serverBaseUrl = config.serverBaseUrl || 'https://api.backend-agency.com/'; 

    // Stop het script als de ID's ontbreken
    if (!measurementId || !tenantId) {
        console.warn('BackendAgency Tracker: Missing measurementId or tenantId');
        return;
    }

    var sentEvents = new Set();
    var lastEventTime = Date.now();
    var isPaused = false;

    // --- HELPERS ---
    function findKey(obj, key, depth) {
      // Begin op diepte 0 als er niks is meegegeven
      depth = depth || 0;
      
      // Beveiliging 1: Stop na 5 levels diep om oneindige loops te voorkomen
      if (depth > 5) return null; 
      
      if (!obj || typeof obj !== 'object') return null;
      
      // Beveiliging 2: Sla HTML elementen (DOM nodes) en Window objecten over!
      // Dit voorkomt crashes bij form submits (Gravity Forms)
      if (typeof obj.nodeType === 'number' || obj === window) return null;

      if (obj[key] !== undefined) return obj[key];
      
      for (var k in obj) {
        if (obj.hasOwnProperty(k) && typeof obj[k] === 'object') {
          var found = findKey(obj[k], key, depth + 1);
          if (found !== null) return found;
        }
      }
      return null;
    }
    // --- COOKIE HELPERS ---
    function setCookie(name, value, minutes) {
      var expires = "";
      if (minutes) {
        var date = new Date();
        date.setTime(date.getTime() + (minutes * 60 * 1000));
        expires = "; expires=" + date.toUTCString();
      }
      var domain = location.hostname.replace(/^www\./i, "");
      document.cookie = name + "=" + (value || "") + expires + "; path=/; domain=." + domain + "; SameSite=Lax";
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

    // --- CLIENT ID & SESSIE BEHEER (Aangepast naar backendagency) ---
    var clientId = (function() {
      var savedCid = getCookie('_backendagency_cid');
      if (savedCid) return savedCid;

      var match = document.cookie.match(/(?:^|; )_ga=([^;]*)/);
      var newCid;
      if (match) { 
        var parts = match[1].split('.'); 
        if (parts.length >= 4) newCid = parts[2] + '.' + parts[3]; 
      }

      if (!newCid) {
        newCid = Math.random().toString(36).substring(2) + '.' + Date.now();
      }
      // Sla de ID op voor 2 jaar
      setCookie('_backendagency_cid', newCid, 1051200); 
      return newCid;
    })();

    // Sessie ID ophalen of nieuw aanmaken
    var sessionId = getCookie('_backendagency_sess_id');
    var isNewSession = false;
    if (!sessionId) {
      sessionId = Math.floor(Date.now() / 1000).toString();
      isNewSession = true;
    }
    setCookie('_backendagency_sess_id', sessionId, 30); // Verleng met 30 min

    // Sessie Count ophalen of ophogen
    var sessionCount = getCookie('_backendagency_sess_count') || "1";
    if (isNewSession) {
      var prevCount = parseInt(getCookie('_backendagency_sess_count') || "0");
      sessionCount = (prevCount + 1).toString();
      setCookie('_backendagency_sess_count', sessionCount, 1051200); 
    }

    document.addEventListener('visibilitychange', function() { 
        isPaused = document.hidden; 
        if(!isPaused) lastEventTime = Date.now(); 
    });

    // --- HOOFD VERZEND FUNCTIE ---
    function sendToSgtm(data) {
      if (!data || !data.event) return;

var eventId = data['gtm.uniqueEventId'];

if (!eventId) {
    eventId = (data.event || 'unknown_event') + '_' + Math.random().toString(36).substring(2, 10);
}


if (sentEvents.has(eventId)) return; 
sentEvents.add(eventId);

      var eventMap = { 
        'gtm.js': 'page_view', 
        'gtm.linkClick': 'click', 
        'gtm.historyChange': 'page_view', 
        'gtm.scroll': 'scroll' 
      };
      
      var eventName = eventMap[data.event] || data.event;
      
      // Negeer dom ready en window load om dubbele pageviews te voorkomen
      if (['gtm.dom', 'gtm.load'].indexOf(eventName) > -1) return;

      var params = [
        'v=2', 'tid=' + measurementId, 'cid=' + encodeURIComponent(clientId),
        'sid=' + sessionId, 'sct=' + sessionCount, 'en=' + encodeURIComponent(eventName),
        'dl=' + encodeURIComponent(window.location.href), 'dr=' + encodeURIComponent(document.referrer || ''),
        'ul=' + (navigator.language || 'nl-nl').toLowerCase(), 'seg=1'
      ];

      if (window.location.search.indexOf('gtm_debug=1') > -1) params.push('_dbg=1');
      if (isNewSession) { params.push('_ss=1'); if (sessionCount === "1") params.push('_fv=1'); }
      
      var engagementTime = isPaused ? 0 : (Date.now() - lastEventTime);
      if (engagementTime > 0 && engagementTime < 1800000) params.push('_et=' + engagementTime);
      
      params.push('ep.tenant_id=' + encodeURIComponent(tenantId));

      // --- ECOMMERCE WAARDEN ---
      // --- ECOMMERCE WAARDEN ---
      var ecommerceObj = data.ecommerce || {};
      
      // Ondersteuning voor Universal Analytics (GA3) structuur
      var uaActionField = (ecommerceObj.purchase && ecommerceObj.purchase.actionField) ? ecommerceObj.purchase.actionField : {};

      // Zoek transaction ID (Direct in root, in GA4 ecommerce, in GA3 actionField, of via findKey)
      var tid = data.transaction_id || ecommerceObj.transaction_id || uaActionField.id || findKey(data, 'transaction_id') || findKey(data, 'transactionId');
      
      // Zoek Value (Direct in root, in GA4 ecommerce, in GA3 actionField, of via findKey)
      var val = data.value || ecommerceObj.value || uaActionField.revenue || findKey(data, 'value') || findKey(data, 'revenue');
      
      // Zoek Currency
      var cur = data.currency || ecommerceObj.currency || 'EUR';

      if (tid) params.push('ep.transaction_id=' + encodeURIComponent(tid));
      if (val !== null && val !== undefined) params.push('epn.value=' + formatNum(val));
      if (cur) params.push('cu=' + encodeURIComponent(cur));

      // --- ITEM EXTRACTIE ---
      var items = null;
      if (data.ecommerce && Array.isArray(data.ecommerce.items)) {
          items = data.ecommerce.items;
      } else if (Array.isArray(data.items)) {
          items = data.items;
      } else {
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

      // --- GA4 COMPRESSIE VOOR ITEMS ---
      if (Array.isArray(items)) {
          items.slice(0, 10).forEach(function(item, i) {
              var parts = [];
              
              var id = item.item_id || item.id || item.item_sku || item.magento_sku || '';
              if (id) parts.push('id' + encodeURIComponent(id));
              
              var nm = item.item_name || item.name || '';
              if (nm) parts.push('nm' + encodeURIComponent(nm));
              
              if (item.price !== undefined) parts.push('pr' + formatNum(item.price));
              if (item.quantity !== undefined) parts.push('qt' + parseInt(item.quantity));
              
              var ca1 = item.item_category || item.category || '';
              if (ca1) parts.push('ca1' + encodeURIComponent(ca1));

              var br = item.item_brand || item.brand || '';
              if (br) parts.push('br' + encodeURIComponent(br));

              if (parts.length > 0) {
                  params.push('pr' + (i + 1) + '=' + parts.join('~'));
              }
          });
      }

      // --- DUAL TRACKING: GA4 + BIGQUERY ---
      var skip = ['event', 'gtm', 'ecommerce', 'eventModel', 'items', 'eventCallback', 'eventTimeout', 'eventSettingsTable', 'user', 'breadcrumb', 'debug_firestore_test'];
      var bqData = {}; 

      for (var key in data) {
        if (data.hasOwnProperty(key) && skip.indexOf(key) === -1) {
          var v = data[key];
          if (v !== null && typeof v !== 'object' && !Array.isArray(v)) {
            params.push(((!isNaN(v) && !isNaN(parseFloat(v))) ? 'epn.' : 'ep.') + key + '=' + encodeURIComponent(v));
            bqData[key] = v;
          }
        }
      }

      if (Array.isArray(items) && items.length > 0) {
          bqData.items = JSON.stringify(items);
      }

      params.push('ep.extra_data=' + encodeURIComponent(JSON.stringify(bqData)));

      // --- VERZENDING ---
      var fullUrl = serverBaseUrl.replace(/\/$/, "") + '/g/collect?' + params.join('&');
      if (navigator.sendBeacon) { navigator.sendBeacon(fullUrl); } 
      else { fetch(fullUrl, { method: 'GET', mode: 'no-cors', keepalive: true }); }
      lastEventTime = Date.now();
    }

    // --- AUTO-TRACKERS ---
    window.onYouTubeIframeAPIReady = function() {
        var frames = document.getElementsByTagName('iframe');
        for (var i = 0; i < frames.length; i++) {
            if (frames[i].src.indexOf('youtube.com') > -1) {
                new YT.Player(frames[i], { events: { 'onStateChange': function(e) {
                    var s = { '0': 'video_complete', '1': 'video_start' };
                    if (s[e.data]) window.dataLayer.push({ event: s[e.data], video_title: e.target.getVideoData().title });
                }}});
            }
        }
    };
    
    if (typeof YT === 'undefined' || typeof YT.Player === 'undefined') {
        var ytTag = document.createElement('script'); ytTag.src = "https://www.youtube.com/iframe_api"; document.head.appendChild(ytTag);
    }

    document.addEventListener('click', function(e) {
        var a = e.target.closest('a'); if (!a || !a.href) return;
        var isExternal = a.hostname !== window.location.hostname;
        if (isExternal) window.dataLayer.push({ event: 'click', outbound: true, link_url: a.href });
        else window.dataLayer.push({ event: 'click', link_url: a.href, link_text: a.innerText });
    }, true);

    document.addEventListener('focusout', function(e) {
        if (['INPUT', 'SELECT', 'TEXTAREA'].indexOf(e.target.tagName) > -1) window.dataLayer.push({ event: 'form_abandonment', field_id: e.target.id || e.target.name || 'unknown' });
    }, true);

    document.addEventListener('submit', function(e) { window.dataLayer.push({ event: 'form_submit', form_id: e.target.id || 'form' }); }, true);

    var sc = [25, 50, 75, 90];
    window.addEventListener('scroll', function() {
        var p = (document.documentElement.scrollTop || document.body.scrollTop) / (document.documentElement.scrollHeight - document.documentElement.clientHeight) * 100;
        sc = sc.filter(function(s) {
            if (p > s) {
                window.dataLayer.push({ event: 'scroll', percent_scrolled: s });
                return false;
            }
            return true; 
        });
    }, {passive: true});

    // --- INITIALISATIE ---
    if (!window.dataLayer) window.dataLayer = [];
    var originalPush = window.dataLayer.push;
    window.dataLayer.push = function() {
      var args = Array.prototype.slice.call(arguments);
      args.forEach(function(obj) { if (obj && typeof obj === 'object' && obj.event) sendToSgtm(obj); });
      return originalPush.apply(window.dataLayer, arguments);
    };
    window.dataLayer.forEach(function(obj) { if (obj && typeof obj === 'object' && obj.event) sendToSgtm(obj); });
  })();

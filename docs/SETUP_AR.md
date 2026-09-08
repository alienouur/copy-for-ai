# دليل الإطلاق (مرة واحدة – حوالي 30 دقيقة)

كل شيء تقني جاهز. المطلوب منك فقط إنشاء الحسابات التي تستلم المال وتنشر الإضافة، لأنها يجب أن تكون باسمك.

## 1) Stripe (استلام المدفوعات) – تم ✅
- حساب Stripe مع **Managed Payments** (Stripe يتكفّل بالضرائب والاحتيال ودعم العملاء).
- منتج **Copy for AI Pro** بسعر 9$ دفعة واحدة، ورابط الدفع: `https://buy.stripe.com/cNieVf5Me70wcA4fdS2Ji00`
- خادم الترخيص منشور على Render: `https://copyforai-license.onrender.com` (المستودع `alienouur/copy-for-ai`، مجلد `server/`، يُعاد نشره تلقائياً عند كل push إلى main).
- الموقع منشور على Render: `https://copyforai.onrender.com` (مجلد `site/`).
- المتبقي عليك:
  1. إكمال "Activate payments" (الحساب البنكي) حتى يصبح رابط الدفع **Active** بدل Paused.
  2. افتح رابط الدفع في Stripe → **Edit** → تبويب **After payment** → "Don't show confirmation page" → Redirect إلى: `https://copyforai.onrender.com/thanks.html?session_id={CHECKOUT_SESSION_ID}`
  3. تدوير مفتاح Stripe المقيّد (Developers → API keys → ⋯ → Roll key) لأنه لُصق في المحادثة، ثم تحديث `STRIPE_RESTRICTED_KEY` في Render → copyforai-license → Environment.

### كيف يعمل الترخيص
بعد الدفع يُحوَّل العميل إلى صفحة `thanks.html`، التي تسأل خادم الترخيص (`server/`) عن جلسة الدفع؛ الخادم يتحقق من Stripe أن الدفع تم ويصدر مفتاحاً موقّعاً (`CFA1.…`). الإضافة تتحقق من توقيع المفتاح محلياً بدون إنترنت. من فقد مفتاحه يستعيده ببريده من نفس الصفحة أو من داخل الإضافة.

## 2) حساب مطوّر Chrome Web Store – 10 دقائق
1. اذهب إلى https://chrome.google.com/webstore/devconsole وسجّل بحساب Google
2. ادفع رسوم التسجيل **5$** (مرة واحدة) وأكمل بيانات الحساب (اسم الناشر + بريد للتواصل)
3. New item → ارفع ملف `release/copy-for-ai-vX.Y.Z.zip` الذي أرسله لك
4. انسخ نصوص القائمة من `docs/STORE_LISTING.md` (الاسم، الوصف، المبررات، الخصوصية)
5. ارفع الصور (أجهّزها لك في `release/`)
6. Submit for review – المراجعة عادة 1–3 أيام

## 3) اختياري: نطاق للموقع
الموقع منشور على `https://copyforai.onrender.com` مجاناً. لو أردت نطاقاً خاصاً (مثل copyforai.app بحوالي 10–15$/سنة) أخبرني وسأربطه.

## 4) بعد النشر (تلقائي / أنا أتابعه)
- تحديثات الإضافة وإصلاح الأخطاء والرد على المراجعات
- إضافة ميزات Pro جديدة كل فترة لرفع نسبة التحويل
- تقارير: عدد التحميلات (من لوحة المتجر) والمبيعات (من Stripe)

## التوقعات
- المتجر يعرض الإضافات الجديدة عضوياً عند البحث عن "markdown chatgpt"، "copy page for AI" وما شابه.
- أول 3 أشهر: غالباً بين 0 و 200$ شهرياً. النمو يعتمد على التقييمات والتحديثات.
- عند نجاح النموذج نكرره على إضافات أخرى (محفظة منتجات).

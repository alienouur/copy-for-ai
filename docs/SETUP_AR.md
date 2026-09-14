# دليل الإطلاق (مرة واحدة – حوالي 30 دقيقة)

كل شيء تقني جاهز. المطلوب منك فقط إنشاء الحسابات التي تستلم المال وتنشر الإضافة، لأنها يجب أن تكون باسمك.

## 1) Stripe (استلام المدفوعات) – تم ✅
- حساب Stripe مع **Managed Payments** (Stripe يتكفّل بالضرائب والاحتيال ودعم العملاء).
- منتج **Copy for AI Pro**. رابط الدفع الحالي: `https://buy.stripe.com/cNieVf5Me70wcA4fdS2Ji00` (أُنشئ كـ 9$ دفعة واحدة — يجب تحويله إلى اشتراك، انظر أدناه).
- خادم الترخيص منشور على Render: `https://copyforai-license.onrender.com` (المستودع `alienouur/copy-for-ai`، مجلد `server/`، يُعاد نشره تلقائياً عند كل push إلى main).
- الموقع منشور على Render: `https://copyforai.onrender.com` (مجلد `site/`).
- المتبقي عليك:
  1. إكمال "Activate payments" (الحساب البنكي) حتى يصبح رابط الدفع **Active** بدل Paused.
  2. افتح رابط الدفع في Stripe → **Edit** → تبويب **After payment** → "Don't show confirmation page" → Redirect إلى: `https://copyforai.onrender.com/thanks.html?session_id={CHECKOUT_SESSION_ID}`
  3. تدوير مفتاح Stripe المقيّد (Developers → API keys → ⋯ → Roll key) لأنه لُصق في المحادثة، ثم تحديث `STRIPE_RESTRICTED_KEY` في Render → copyforai-license → Environment. عند إعادة إنشائه أضف صلاحية **Subscriptions: Read** (يحتاجها الخادم للتحقق من أن الاشتراك ما زال فعّالاً).
  4. **تحويل Pro إلى اشتراك 4.99$/شهر:** Product catalog → Copy for AI Pro → Add another price → **Recurring** · Monthly · 4.99 USD → Save. ثم Payment links → New → اختر السعر الشهري → فعّل Managed Payments وAllow promotion codes → After payment: Redirect إلى نفس رابط thanks.html أعلاه → Create. أرسل لي الرابط الجديد `https://buy.stripe.com/...` لأضعه في الإضافة والموقع (يمكن بعدها أرشفة سعر 9$ وتعطيل رابطه القديم).

## 1-ب) Gemini (محرّك الحل) – مطلوب مرة واحدة
1. https://aistudio.google.com/apikey → **Create API key** → اربطه بمشروع Google Cloud وفعّل **Billing** عليه (بدون فوترة الحد المجاني منخفض جداً وسيتوقف الحل عند الازدحام).
2. Render → copyforai-license → **Environment** → أضف `GEMINI_API_KEY` = المفتاح → Save (يُعاد نشر الخادم تلقائياً).
3. اختياري: في Google Cloud → APIs & Services → Credentials → المفتاح → **API restrictions** → Generative Language API فقط. وضع تنبيه ميزانية (Billing → Budgets) عند 20$/شهر مثلاً.
4. التكلفة التقريبية مع gemini-2.5-flash: 0.1–0.3 سنت للسؤال النصي، و≈0.5 سنت مع لقطة شاشة. مشترك Pro يستخدم 100 سؤال/شهر يكلّف ≈0.3–0.5$ مقابل 4.99$. المجاني محدود بـ 5 أسئلة/يوم لكل جهاز و150/يوم لكل IP.
5. تحقّق: `https://copyforai-license.onrender.com/healthz` يجب أن يُظهر `"solver":true`.

### كيف يعمل الترخيص
بعد الدفع يُحوَّل العميل إلى صفحة `thanks.html`، التي تسأل خادم الترخيص (`server/`) عن جلسة الدفع؛ الخادم يتحقق من Stripe أن الدفع تم ويصدر مفتاحاً موقّعاً (`CFA1.…`). الإضافة تتحقق من توقيع المفتاح محلياً بدون إنترنت. من فقد مفتاحه يستعيده ببريده من نفس الصفحة أو من داخل الإضافة.

### كيف يعمل الحل (Solve)
الإضافة تقرأ نص الصفحة (أو النص المحدد) وتلتقط لقطة للجزء الظاهر إن كان الخيار مفعّلاً أو لم يوجد نص مقروء، وترسلهما إلى `POST /v1/solve` على الخادم. الخادم يتحقق من الخطة (مجاني: 5/يوم لكل جهاز؛ Pro: يتأكد من Stripe أن الاشتراك المرتبط بالبريد **active**، مع تخزين النتيجة 6 ساعات) ثم يستدعي Gemini بمفتاحك ويعيد الجواب. مفتاح Gemini لا يغادر الخادم أبداً، ولا يُسجَّل أي نص أو صورة.

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
- المتجر يعرض الإضافات الجديدة عضوياً عند البحث عن "homework solver"، "quiz answers"، "solve questions AI" وما شابه (سوق الطلبة أكبر بكثير من سوق Markdown).
- أول 3 أشهر: غالباً بين 0 و 200$ شهرياً. النمو يعتمد على التقييمات والتحديثات.
- عند نجاح النموذج نكرره على إضافات أخرى (محفظة منتجات).

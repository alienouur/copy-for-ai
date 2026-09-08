# دليل الإطلاق (مرة واحدة – حوالي 30 دقيقة)

كل شيء تقني جاهز. المطلوب منك فقط إنشاء الحسابات التي تستلم المال وتنشر الإضافة، لأنها يجب أن تكون باسمك.

## 1) حساب Lemon Squeezy (استلام المدفوعات) – 10 دقائق
1. سجّل في https://app.lemonsqueezy.com/register
2. أنشئ متجراً (Store). الاسم المقترح: `Copy for AI`، الرابط الفرعي: `copyforai`
3. Products → New product:
   - الاسم: **Copy for AI Pro**
   - السعر: **$9** – One-time payment
   - في تبويب **License keys**: فعّل "Generate license keys" وضع Activation limit = **3**
   - احفظ، ثم من Share انسخ **Checkout link**
4. Settings → Payouts: أضف وسيلة الاستلام (PayPal أو حساب بنكي).
5. أرسل لي:
   - رابط الـ Checkout (شكله: `https://copyforai.lemonsqueezy.com/buy/xxxxxxxx`)
   - رقم الـ Store ID (Settings → Stores)

سأضعهما في `src/lib/config.js` وأبني الإصدار النهائي.

## 2) حساب مطوّر Chrome Web Store – 10 دقائق
1. اذهب إلى https://chrome.google.com/webstore/devconsole وسجّل بحساب Google
2. ادفع رسوم التسجيل **5$** (مرة واحدة) وأكمل بيانات الحساب (اسم الناشر + بريد للتواصل)
3. New item → ارفع ملف `release/copy-for-ai-vX.Y.Z.zip` الذي أرسله لك
4. انسخ نصوص القائمة من `docs/STORE_LISTING.md` (الاسم، الوصف، المبررات، الخصوصية)
5. ارفع الصور (أجهّزها لك في `release/`)
6. Submit for review – المراجعة عادة 1–3 أيام

## 3) اختياري: نطاق للموقع
الموقع سينشر على رابط `*.devinapps.com` مجاناً. لو أردت نطاقاً خاصاً (مثل copyforai.app بحوالي 10–15$/سنة) أخبرني وسأربطه.

## 4) بعد النشر (تلقائي / أنا أتابعه)
- تحديثات الإضافة وإصلاح الأخطاء والرد على المراجعات
- إضافة ميزات Pro جديدة كل فترة لرفع نسبة التحويل
- تقارير: عدد التحميلات (من لوحة المتجر) والمبيعات (من Lemon Squeezy)

## التوقعات
- المتجر يعرض الإضافات الجديدة عضوياً عند البحث عن "markdown chatgpt"، "copy page for AI" وما شابه.
- أول 3 أشهر: غالباً بين 0 و 200$ شهرياً. النمو يعتمد على التقييمات والتحديثات.
- عند نجاح النموذج نكرره على إضافات أخرى (محفظة منتجات).

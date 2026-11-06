# Jesr — حالة التنفيذ (صادقة)

## منفَّذ ومُختبَر منطقياً (8/8 اختبارات ناجحة، Node 22 + esbuild)
`lib/jesr/`:
- `identity.ts` — Jesr ID مشتق من SHA‑256 للمفتاح العام (لا يمكن انتحاله بمعرفة المعرّف)، منفصل عن nodeId.
- `protocol.ts` — مغلّف موقّع: التحقق من ربط ID↔المفتاح، التوقيع، ثم فك التشفير. الوسيط يرى `to/id/type/ts` فقط.
- `engine.ts` — الأصدقاء (طلب/قبول/رفض، منع التكرار، لا إضافة دون موافقة)، الرسائل، حالات Sending→Sent→Delivered،
  ACK موقّع من المستلم بعد فك التشفير والحفظ، منع التكرار وإعادة الإرسال مع backoff، طابور Store‑and‑Forward دائم بانتهاء 7 أيام.
- `crypto-provider.ts`, `storage.ts` — حدود الطبقات (واجهات).

الاختبارات: `tests/jesr/engine.test.ts` (تشغيل: esbuild ثم `node --test`).

## غير منفَّذ بعد (لا تدّعِ العمل به)
1. **موفّر التشفير الحقيقي**: مزوّد الاختبار (`tests/jesr/test-crypto.ts`) يستخدم node:crypto ولا يعمل داخل التطبيق.
   المطلوب جسر Kotlin إلى Android Keystore + مكتبة موثوقة (Matrix Rust Crypto/Olm أو libsodium). لا مفاتيح داخل JavaScript.
2. **قاعدة بيانات مشفرة** (SQLCipher + مفتاح في Keystore) تطبّق `KeyValueStore`.
3. **ربط المحرك بالشبكة**: تحويل `Envelope` إلى حزمة `MeshRouter` من نوع جديد `data` (الراوتر الحالي: ping/ack/route فقط)
   مع TTL ومنع الحلقات، ثم Transport يطبّق `send()`.
4. **الواجهة** بتصميم الصورة (قائمة الأصدقاء، Bottom Sheet 2×2، المحادثة، الإعدادات، Color Wheel، RTL).
5. استعادة/نقل الهوية، البحث بالاسم والأجهزة القريبة، استيراد جهات الاتصال.
6. **بناء APK** (لا Android SDK ولا إنترنت في بيئتي) واختبار BLE/Wi‑Fi Direct على أجهزة حقيقية.

## ملاحظة تصميمية
لأن Jesr ID مشتق من المفتاح، تغيّر المفتاح = هوية/ID جديد (لا يمكن لمفتاح مختلف ادعاء المعرّف نفسه)؛ نقل الهوية يتم بنسخ احتياطي للمفتاح الخاص.

---
## تحديث: ما أُضيف في هذه الجولة (صادق)

**مُختبَر منطقياً (10/10 اختبارات `node --test`):** حزمة `data` في `MeshRouter` (TS)، وتكامل `JesrEngine` عبر ثلاث عقد A→B→C
(الوسيط يرى نصاً مشفراً فقط، ACK موقّع يعيد الحالة إلى Delivered).

**كُتب ولم يُترجَم/يُشغَّل (يتطلب بناء Android منك):**
- `MeshRouter.kt`: نوع `data` + `sendData` + `aliases` + `dataSink` (يعكس منطق TS). لا يُخزَّن `data` في الراوتر؛ الطابور الدائم في المحرك.
- `JesrCrypto.kt` (libsodium: Ed25519 / X25519 / XChaCha20‑Poly1305)، `JesrKeystore.kt` (AES‑GCM بمفتاح Android Keystore + كتابة ملفات ذرّية).
  أسماء دوال libsodium كُتبت من الذاكرة؛ قد يظهر خطأ ترجمة طفيف عند أول build.
- `JesrNetworkModule.kt`: `setJesrId`, `sendData`, `crypto*`, `secure*`, حدث `onJesrData`.
- TS: `native-crypto.ts`, `mesh-transport.ts`, `runtime.tsx` (مزوّد + خطاف).
- الواجهة: `(tabs)/chats.tsx`, `chat/[id].tsx`, `(tabs)/me.tsx` بتصميم الصورة (أخضر مريمي، RTL).
  في الويب/Expo Go تظهر بيانات معاينة موسومة بوضوح بلا تشفير ولا شبكة.

**لم يُنفَّذ:** استيراد جهات الاتصال، نقل/استعادة الهوية، القصص (الدائرة + في الواجهة شكلية فقط)، مكالمات الفيديو/الصوت،
ومنع الاعتماد على flooding لكل رسالة (التوجيه بمعرّف Jesr يعتمد الفيضان المحدود لأن nodeId ≠ Jesr ID).
**لم يُجرَّب:** `tsc`/`vitest` على كامل المشروع (لا node_modules هنا)، البناء، BLE/Wi‑Fi Direct على أجهزة.

# إعداد حماية Google للإصدار Jesr 3.5

هذه الوثيقة تحدد إعداد الإنتاج المطلوب. وجود مكتبة App Check داخل APK لا يعني أن Firebase يرفض الطلبات غير الموثقة؛ يجب تسجيل التطبيق وشهادة التوقيع ثم تفعيل Enforcement من Firebase Console.

## هوية التطبيق المسجلة في المشروع

- Android applicationId: `com.aistudio.jesr.mesh`
- Firebase project ID: `com-aistudio-android-jesr-mesh-a5ee5`
- Firebase project number: `652128428398`
- Firebase Firestore database ID: `ai-studio-android-jesr-f53f4f4c-80da-4fb8-bd4f-7adf47ebc695`

## إعداد Play Integrity وFirebase App Check

1. افتح Google Play Console واختر التطبيق. من صفحة App integrity اربط مشروع Google Cloud الخاص بالتطبيق بمشروع Firebase أعلاه، وتأكد من تفعيل Play Integrity API.
2. في Firebase Console افتح Security → App Check → Apps، وسجّل تطبيق Android ذي الحزمة `com.aistudio.jesr.mesh` باستخدام Play Integrity.
3. أضف SHA-256 لشهادة التوقيع الفعلية. إذا استُخدم Google Play App Signing، أضف بصمة App signing certificate التي تعرضها Play Console، لا تكتفِ ببصمة Upload key. إذا وزّعت APK مباشرة، سجّل بصمة شهادة التوقيع الدائمة التي أنشأها مالك التطبيق.
4. راجع إعدادات Play Integrity المتقدمة حسب قناة التوزيع. لا تفرض PLAY_RECOGNIZED أو LICENSED إذا كنت ستوزع APK خارج Google Play فقط؛ فهذا قد يمنع النسخ الجانبية من العمل.
5. بعد تثبيت نسخة موقعة بشهادة الإنتاج على جهاز حقيقي، افتح App Check metrics وتأكد من ظهور الطلبات كموثقة.
6. بعد التحقق من مرور الاستخدام المشروع، فعّل Enforcement للخدمات التي يستخدمها التطبيق فعلاً: Cloud Firestore وCloud Storage وAuthentication وCloud Functions إن كانت مستخدمة. لا تفعّل خدمة غير مستخدمة أو قبل مراقبة المقاييس.
7. احتفظ بمفتاح التوقيع خارج المستودع. لا ترفع ملف JKS أو كلمات مروره أو Debug App Check token إلى GitHub.

## توقيع إصدار Release عبر GitHub Actions

أُضيف مسار Release منفصل. لكي ينتج APK إنتاجياً، أنشئ مفتاح توقيع دائم خاصاً بالتطبيق ثم أضف القيم التالية في GitHub → Settings → Secrets and variables → Actions:

- `ANDROID_KEYSTORE_BASE64`: محتوى ملف JKS بعد تحويله إلى Base64.
- `ANDROID_STORE_PASSWORD`: كلمة مرور keystore.
- `ANDROID_KEY_ALIAS`: اسم alias.
- `ANDROID_KEY_PASSWORD`: كلمة مرور المفتاح.

لا تضع هذه القيم في ملفات المستودع أو في المحادثة. إذا لم تُضف القيم الأربع، سيستمر CI بفحص Debug فقط ولن يصدر APK على أنه Release.

## Firestore Security Rules

يحتوي المشروع على `firestore.rules` واختبارات Emulator. نجاح اختبارات Emulator يثبت سلوك القواعد محلياً فقط، ولا ينشرها على مشروع Firebase. قبل النشر الفعلي، راجع القواعد في Firebase Console ثم انشرها إلى قاعدة البيانات المحددة أعلاه باستخدام حساب مالك المشروع. اختبر تسجيل الدخول والقراءة والكتابة المسموح بها بعد النشر.

## ما لا يمكن تفعيله من مستودع GitHub وحده

تسجيل SHA-256 في Firebase App Check، ربط Google Play Integrity بمشروع Cloud، وتفعيل Enforcement تغييرات على حسابات Google/Firebase. لا يمكن إتمامها بمجرد تعديل Kotlin أو GitHub Actions. لا تعتبر الحماية مفعّلة بالكامل قبل إتمام خطوات Console والتحقق من المقاييس.

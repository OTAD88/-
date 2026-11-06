# ملاحظات تقنية موثقة

تمت مراجعة صفحات Android Developers وExpo Docs بتاريخ 2026-10-31. المصدر المباشر لكل نقطة أدناه محفوظ في الرابط.

- **Wi‑Fi Direct والصلاحيات:** توثيق Android يبين استخدام `WifiP2pManager` للاكتشاف والاتصال، ويوضح أن Android 13+ يتطلب `NEARBY_WIFI_DEVICES` لعمليات `discoverPeers()` و`connect()`، مع `ACCESS_FINE_LOCATION` للإصدارات الأقدم، وأن مقابس Java مطلوبة لنقل البيانات المحلية. بعض واجهات الاكتشاف تتطلب تفعيل Location Mode في النظام رغم عدم استخدام GPS؛ يجب شرح ذلك بدل طلب بيانات موقع دون حاجة. [1] [2]
- **BLE:** بدءًا من Android 12 تُطلب أذونات `BLUETOOTH_SCAN` و`BLUETOOTH_ADVERTISE` و`BLUETOOTH_CONNECT` بحسب الوظيفة. يمكن التصريح `neverForLocation` إذا لم تُشتق المواقع، لكن قد تُصفّى بعض الإشارات. على الإصدارات القديمة تختلف الأذونات وقد يلزم الموقع لمسح BLE. [3]
- **الخدمة في الخلفية:** بدءًا من Android 14 يجب إعلان نوع foreground service وصلاحية النوع، ونوع `connectedDevice` مناسب لتواصل الأجهزة عبر Bluetooth/Wi‑Fi، مع متطلبات الإذن المسبق والقيود النظامية. [4]
- **Expo:** يسمح Expo بإنشاء وحدة محلية داخل `modules/` مع Kotlin على Android. لا تعمل الشيفرة native المخصصة في Expo Go؛ يلزم development/release build أصلي، وتستخدم config plugins لإدخال إعدادات Manifest في CNG. [5] [6]
- **APK:** يمكن إعداد ملف `eas.json` لإنتاج APK، لكن تسليم APK لا يصح إلا بعد نتيجة build ناجحة فعلًا. [7]

## المراجع

[1]: https://developer.android.com/develop/connectivity/wifi/wifi-permissions "Android: أذونات الأجهزة القريبة وWi‑Fi"
[2]: https://developer.android.com/develop/connectivity/wifi/wifip2p "Android: Wi‑Fi Direct P2P"
[3]: https://developer.android.com/guide/topics/connectivity/bluetooth/permissions "Android: أذونات Bluetooth"
[4]: https://developer.android.com/develop/background-work/services/fgs/service-types#connected-device "Android: أنواع foreground service للأجهزة المتصلة"
[5]: https://docs.expo.dev/modules/get-started/ "Expo: إنشاء وحدة محلية"
[6]: https://docs.expo.dev/workflow/customizing/ "Expo: إضافة شيفرة أصلية مخصصة"
[7]: https://docs.expo.dev/build-reference/apk/ "Expo: بناء APK Android"
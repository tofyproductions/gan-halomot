import UIKit
import Capacitor
import FirebaseCore
import FirebaseMessaging

/**
 * Push on iOS does not work the way it does on Android, and the difference is
 * the whole reason this file is not the stock Capacitor template.
 *
 * On Android, @capacitor/push-notifications bundles the Firebase SDK itself:
 * you drop in google-services.json and the plugin hands you an FCM token. On
 * iOS the same plugin talks to APNs directly and knows nothing about Firebase
 * — its README says so — so out of the box it would hand us an APNs device
 * token. Our server sends through FCM (server/src/services/fcm.service.js),
 * and FCM rejects an APNs token as an invalid registration token. The symptom
 * is the worst kind: permission granted, no error anywhere, and not a single
 * notification delivered.
 *
 * There is a second gap the stock template leaves. The plugin does not hook
 * UIApplicationDelegate itself; it waits on the two NotificationCenter posts
 * below, and the template ships without them. Without those, `register()`
 * rejects with "event capacitorDidRegisterForRemoteNotifications not called"
 * and no token is ever produced at all.
 *
 * So both halves are here: Firebase is configured, the APNs token is handed to
 * Firebase, and the token we post onward is the FCM one the server can use.
 *
 * Swizzling is disabled (FirebaseAppDelegateProxyEnabled = NO in Info.plist)
 * so that the registration path is exactly what is written here rather than
 * something Firebase rewrites at runtime. That makes setting `apnsToken`
 * mandatory rather than optional — Firebase cannot mint an FCM token without
 * it.
 */
@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate, MessagingDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        FirebaseApp.configure()
        Messaging.messaging().delegate = self
        return true
    }

    // MARK: - Push registration

    /// APNs answered. Give the token to Firebase, then ask Firebase for the FCM
    /// token and pass *that* to the plugin — the plugin forwards whatever this
    /// notification carries to JavaScript as the `registration` value, and the
    /// server stores it as the device address.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Messaging.messaging().apnsToken = deviceToken

        Messaging.messaging().token { token, error in
            if let token = token {
                NotificationCenter.default.post(
                    name: .capacitorDidRegisterForRemoteNotifications,
                    object: token
                )
            } else {
                NotificationCenter.default.post(
                    name: .capacitorDidFailToRegisterForRemoteNotifications,
                    object: error
                )
            }
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(
            name: .capacitorDidFailToRegisterForRemoteNotifications,
            object: error
        )
    }

    /// Firebase rotates the FCM token on its own schedule — reinstall, restore
    /// from backup, or its own housekeeping. Posting the new one here sends it
    /// through the same path as the first registration, and the server upserts
    /// on the token, so the old row dies on its next send with UNREGISTERED.
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let fcmToken = fcmToken else { return }
        NotificationCenter.default.post(
            name: .capacitorDidRegisterForRemoteNotifications,
            object: fcmToken
        )
    }

    // MARK: - Capacitor lifecycle (unchanged from the template)

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

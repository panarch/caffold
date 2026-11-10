# Use other devices

A phone, a tablet, or another computer opens the same Caffold as the host: the
same Tasks, conversations, and approvals. It reaches the host through a private
HTTPS address that [Tailscale](https://tailscale.com/download) provides, which
only devices signed in to your tailnet can open.

![Settings → Remote Access with the private address and its QR code](../assets/screenshots/settings-remote-access-light-desktop.png#only-light)
![Settings → Remote Access with the private address and its QR code](../assets/screenshots/settings-remote-access-dark-desktop.png#only-dark)

## Turn on private access

1. Install Tailscale on the host and connect it to your tailnet.
2. On the host, open Caffold and go to **Settings → Remote Access**. On other
   devices this page is read-only.
3. Choose **Enable**.

On Linux, the [install script](install.md#install-on-linux) turns it on. If
you install Tailscale later, run the script again.

When the page reports **Private access is ready**, it shows the private
address with **Copy link**, **Open link**, and a QR code for it.

## Open Caffold on another device

1. Install Tailscale on the device and sign in to an account permitted on the
   same tailnet.
2. Scan the QR code, or open the copied address. On another device, always use
   this address: `127.0.0.1` on a phone points at the phone, not at the host.
3. To keep Caffold on the home screen, install it as an app. In Safari on an
   iPhone or iPad, choose **Share**, then **Add to Home Screen**. In Chrome,
   open the browser menu and choose **Add to Home screen** or **Install app**.

![A Task on a phone](../assets/screenshots/task-conversation-light-phone.png#only-light){ width="300" }
![A Task on a phone](../assets/screenshots/task-conversation-dark-phone.png#only-dark){ width="300" }

The installed app has its own window and icon, and it updates with the host.
You can install the app on the host itself as well, from
`http://127.0.0.1:5178`.

To be told when a turn ends while you are away, turn on
[Notifications](notifications.md) on the device.

## More than one host

If you run Caffold on more than one host, give each one its own **Name** and
icon color under **Settings → Name & Icon** before installing it on a device, so
the installed apps can be told apart. An app installed earlier keeps its old
name and icon until you install it again.

# Yumak Bot'u sunucuda çalıştırma (Docker)

## Tek komutla kurulum

Boş bir Ubuntu (22.04 ve sonrası) ya da Debian (12 ve sonrası) sunucuda, en az 2 GB bellekle (4 GB önerilir):

```bash
curl -fsSL https://raw.githubusercontent.com/esmworks/yumakbot/main/docker/install.sh | sudo bash -s -- --lang tr
```

`install.sh` sırasıyla:

1. En son sürümü `/opt/yumakbot` altına indirir ve işin geri kalanını o sürümün kendi betiğine bırakır.
2. Docker'ı kurar (26 ya da sonrası gerekir).
3. `docker/.env` dosyasını rastgele parola ve anahtarlarla doldurur; yeniden çalıştırınca bunlar değişmez.
4. `apparmor.sh` ile AppArmor'u ayarlar (bkz. "AppArmor").
5. Hazır imajları indirir; o sürümün imajı yoksa sunucuda derler (10–20 dakika, 4 GB'tan az bellekte yarıda
   kalabilir).
6. Kapsayıcıları `compose.yml` ile `compose.vps.yml` birlikte başlatır. İkincisi Caddy'yi ekler; Caddy 80 ve 443
   numaralı bağlantı noktalarında dinler ve Let's Encrypt sertifikasını kendisi alıp yeniler.
7. `firewall.sh` kurallarını uygular ve her açılışta ve Docker her yeniden başladığında yeniden uygulayan
   `yumakbot-firewall` systemd servisini kurar. `ufw` açıksa 80 ve 443'e izin verir.
8. Adresi ve erişim anahtarını yazar.

Alan adı verilmezse sunucunun genel IP adresinden bir ad kullanılır: `203.0.113.7` için `203-0-113-7.sslip.io`. Bu ad
sslip.io'nun DNS hizmetine dayanır. Kendi alan adınız varsa önce DNS kaydını sunucuya yönlendirin, sonra
`--domain bot.example.com` verin. Sağlayıcının güvenlik duvarında 80 ve 443 açık olmalıdır.

| Seçenek                | Anlamı                                                                  |
| ---------------------- | ----------------------------------------------------------------------- |
| `--domain AD`          | Sunucunun alan adı                                                      |
| `--version vX.Y.Z`     | Kurulacak sürüm (varsayılan: en son sürüm)                              |
| `--computer`           | Botların bilgisayarını açar (8 GB önerilir); `--no-computer` kapatır    |
| `--access-key ANAHTAR` | Erişim anahtarını siz seçin (en az 24 karakter: harf, rakam, `- _ . ~`) |
| `--dir KLASÖR`         | Kurulum klasörü (varsayılan: `/opt/yumakbot`)                           |
| `--lang tr`            | İletiler Türkçe                                                         |

Kurulumdan sonra aynı betik `yumakbot` komutuyla çalışır:

```bash
sudo yumakbot update        # en son sürüme günceller; ayarlar ve veriler kalır
sudo yumakbot status        # kapsayıcılar ve sunucunun yanıtı
sudo yumakbot logs [servis] # kayıtlar (yumakbot, caddy, db, computer)
sudo yumakbot access-key    # erişim anahtarı
sudo yumakbot compose ...   # bu kurulumun dosyalarıyla docker compose
```

`update` seçenek alır: `sudo yumakbot update --computer` botların bilgisayarını sonradan açar.

### Sunucuyu oluştururken (cloud-init)

Hetzner, DigitalOcean, Vultr gibi sağlayıcılar sunucu oluşturma ekranında "Cloud config" ya da "User data" kutusu
verir. Oraya yapıştırılan metin kurulumu SSH'a hiç girmeden yapar:

```yaml
#cloud-config
runcmd:
  - curl -fsSL https://raw.githubusercontent.com/esmworks/yumakbot/main/docker/install.sh | bash -s -- --lang tr --access-key UZUN-RASTGELE-BIR-ANAHTAR
```

Erişim anahtarını burada siz seçersiniz, çünkü betiğin çıktısı sunucuda bir kayıt dosyasına yazılır ve anahtar oraya
yazdırılmaz. Birkaç dakika sonra `https://<IP-adresi-tireli>.sslip.io` adresini açın. Kurulumun gidişi sunucuda
`/var/log/cloud-init-output.log` dosyasındadır.

### Ters vekil ve giriş sınırı

Aynı adresten 15 dakikada 10 yanlış şifre o adresi bekletir. Ters vekilin arkasında bütün istekler vekilin adresinden
gelir; vekil tanıtılmazsa bir kişinin yanlış denemeleri herkesi bekletir. Bunun için vekil `YUMAKBOT_PROXY_SECRET`
değerini `X-Yumakbot-Proxy` başlığında, kişinin adresini `X-Forwarded-For` başlığında gönderir; sunucu
`X-Forwarded-For`'a yalnızca bu sırla gelen isteklerde güvenir. `install.sh` bunu kendisi ayarlar. Elle kurulan bir
nginx için:

```nginx
proxy_set_header X-Yumakbot-Proxy <YUMAKBOT_PROXY_SECRET değeri>;
proxy_set_header X-Forwarded-For $remote_addr;
```

## Elle kurulum

```bash
cp docker/.env.example docker/.env      # değerleri doldurun
sudo ./docker/apparmor.sh --env docker/.env   # Linux ana makinede, bir kez; bkz. "AppArmor"
docker compose -f docker/compose.yml --env-file docker/.env up -d --build
sudo ./docker/firewall.sh               # Linux ana makinede, compose'dan sonra
```

Sunucu yalnızca ana makinenin `127.0.0.1:4319` adresinde dinler. Uzaktan erişim için bkz. "Uzaktan erişim".

## Uzaktan erişim

Sunucuyu dışarıya açmanın üç yolu var; hiçbiri ana makinede bir port açmaz, ilk ikisi ters vekil de istemez.

**Cloudflare Tunnel** (herkese açık bir alan adıyla, HTTPS Cloudflare'den):

1. Cloudflare panelinde Zero Trust → Networks → Tunnels → Create a tunnel (Cloudflared) ile bir tünel açın ve
   jetonunu `.env` dosyasında `CLOUDFLARE_TUNNEL_TOKEN` değerine yazın.
2. Tünelin Public Hostname ayarına alan adınızı (ör. `bot.ornek.com`) ve servis olarak `http://yumakbot:4319`
   yazın.
3. `.env` dosyasında `YUMAKBOT_PUBLIC_URL=https://bot.ornek.com` ve `YUMAKBOT_SECURE_COOKIES=1` yapın.
4. Vekili tanıtın (bkz. "Ters vekil ve giriş sınırı"): `.env` dosyasında `YUMAKBOT_PROXY_SECRET` boşsa
   `openssl rand -hex 32` ile doldurun. Cloudflare panelinde alan adınızın Rules → Transform Rules → Modify
   Request Header bölümünde bir kural açın: koşul `Hostname equals bot.ornek.com`, işlem "Set static",
   başlık `X-Yumakbot-Proxy`, değer `YUMAKBOT_PROXY_SECRET` değeri. Cloudflare kişinin adresini
   `X-Forwarded-For` başlığının sonuna kendisi yazar. Kural yoksa bütün girişler tünel kapsayıcısının
   adresinden sayılır ve bir kişinin yanlış şifreleri herkesi bekletir.
5. `docker compose -f docker/compose.yml --env-file docker/.env --profile cloudflare up -d`

**Tailscale** (yalnız tailnet'inizdeki cihazlardan, `https://yumakbot.<tailnet>.ts.net`):

1. Tailscale yönetim panelinde bir auth key oluşturup `.env` dosyasında `TAILSCALE_AUTHKEY` değerine yazın;
   tailnet'inizde HTTPS sertifikalarını açın (DNS → HTTPS Certificates).
2. `.env` dosyasında `YUMAKBOT_PUBLIC_URL=https://yumakbot.<tailnet>.ts.net` ve `YUMAKBOT_SECURE_COOKIES=1` yapın.
3. `docker compose -f docker/compose.yml --env-file docker/.env --profile tailscale up -d`

Tailscale'in `serve` özelliği isteğe kendi başlığını ekleyemez, bu yüzden `X-Yumakbot-Proxy` gönderilmez ve
girişler tünel kapsayıcısının adresinden sayılır: tailnet'teki bir cihazdan 15 dakikada 10 yanlış şifre bütün
cihazları bekletir. Sunucuya yalnızca tailnet'inizdeki cihazlar ulaştığı için tek kişilik bir tailnet'te bu
sorun değildir. Tailnet'i başkalarıyla paylaşıyorsanız Tailscale ile sunucunun arasına başlığı ekleyen bir
ters vekil (Caddy, nginx) koyun ya da Cloudflare Tunnel kullanın.

Tünel kapsayıcıları sunucuya yalnızca kendi iç ağlarından (`edge`) ulaşır; sunucuya oradan dışarıya yeni bir yol
açılmaz.

**Kendi ters vekiliniz** (Caddy, nginx): önüne TLS veren vekili koyun, `YUMAKBOT_ALLOWED_HOSTS` değerine alan adını,
`YUMAKBOT_SECURE_COOKIES=1` yazın.

Telefonu ya da başka bir bilgisayarı bağlamak için şifre yazmanız gerekmez: oturumu açık bir cihazda Ayarlar →
Bağlantı → Başka bir cihaz bağla ile bir eşleştirme kodu alın, öbür cihazda sunucu adresini girip "Eşleştirme
koduyla gir"i seçin. Kod bir kez ve beş dakika içinde çalışır; yanlış kodlar yanlış şifrelerle birlikte sayılır.

## Uygulamaya giriş

İlk girişte `.env` dosyasındaki `YUMAKBOT_ACCESS_KEY` yazılır. Hemen ardından uygulama bir kullanıcı adı ve
şifre ister; sonraki girişler bunlarla yapılır. Veritabanında şifrenin kendisi değil, yalnızca scrypt özeti
durur. Hesap Ayarlar → Bağlantı bölümünden mevcut şifreyle değiştirilir; şifre unutulursa giriş ekranındaki
"Şifremi unuttum, erişim anahtarıyla gir" ile girilip mevcut şifre yerine erişim anahtarı yazılır. Aynı
adresten 15 dakikada 10 yanlış şifre denemesi olursa o adres bekletilir.

## Claude girişi

Claude'u uygulamadan bağlayın: ilk açılıştaki kurulumda ya da sonra Ayarlar → Bağlantı → Claude
bölümünde iki yol vardır:

- **Claude aboneliği:** Claude Code kurulu herhangi bir bilgisayarda `claude setup-token` çalıştırın,
  tarayıcıda giriş yapın ve çıkan belirteci (`sk-ant-oat…`) yapıştırın.
- **Anthropic API anahtarı:** console.anthropic.com'dan alınan anahtar; her istek ayrıca ücretlendirilir.

"Kaydet ve dene" belirteci ya da anahtarı tek bir kısa istekle dener. Değer, kasa ile aynı anahtarla
(`/data/vault.key`) şifrelenip veritabanında saklanır; uygulama yalnızca son dört karakterini gösterir.
Claude, botun çalıştırdığı komutların ortamından bu değişkenleri siler; bot belirteci okuyamaz.

Sunucunun ortamındaki `ANTHROPIC_API_KEY` kullanılmaz: kullandıkça ödemeye geçiş yalnızca uygulamadan
seçilerek olur.

Kapsayıcının içinde Claude Code ile giriş de hâlâ çalışır; uygulamada bir belirteç ya da anahtar
kayıtlıysa o kullanılır:

```bash
docker compose -f docker/compose.yml --env-file docker/.env exec -it yumakbot sh -c \
  'exec $(find node_modules/.pnpm -path "*claude-agent-sdk-linux*/claude" -type f | head -1) auth login'
```

## Kapsayıcının sınırları

- Root olmayan kullanıcı (uid 10001), salt okunur kök dosya sistemi; yazılabilir yalnızca `/data` ve `tmpfs`.
- Bütün yetkiler kapalı (`cap_drop: ALL`), `no-new-privileges`, bellek, işlemci ve süreç sınırı.
- Veritabanı yalnızca iç ağda; internete çıkamaz ve ana makineye açılmaz.
- `firewall.sh`: kapsayıcıdan ev/ofis ağına, bulut gizli adreslerine ve IPv6 yerel adreslere çıkış kapalı.
  Ana makinenin kendisine de (köprünün ağ geçidi, ana makinenin yerel ya da genel adresi) yalnızca ana
  makinenin açtığı bağlantıların yanıtları gelir: ana makinede `0.0.0.0` üzerinde dinleyen bir servis
  (Ollama, veritabanı, yönetim paneli) botlara kapalıdır. Kapsayıcılar adları Docker'ın kendi çözücüsüyle
  (`127.0.0.11`) çözer, bunun için ana makinede açık bir port gerekmez. Bir botun ana makinedeki bir
  servise gerçekten ulaşması gerekiyorsa o servisi bir Docker ağına koyun; kuralı gevşetmeyin.

## Kişi başında değilken

Rutinlerin ve başka botların başlattığı turlarda açılan izin kartı ve soru, `YUMAKBOT_UNATTENDED_HOURS` saat
(varsayılan 12, en çok 576) içinde yanıtlanmazsa reddedilir; bot bunu bilerek işine devam eder. Kişinin kendi
yazdığı mesajla başlayan turlarda kart süresiz bekler.

## Botların tarayıcısı

Her bot web sitelerinde iş yapmak için kendi tarayıcısını kullanır. İmajda Chromium kuruludur
(`YUMAKBOT_BROWSER=/usr/bin/chromium`). Her botun ayrı bir profili `/data/browsers/<bot>` altında durur;
girişler ve çerezler orada kalır, botlar birbirinin profilini görmez.

- Tarayıcı ilk kullanımda açılır; kimse izlemiyorsa ve bot 15 dakika kullanmazsa kapanır. Aynı anda en çok
  `YUMAKBOT_MAX_BROWSERS` (varsayılan 3) tarayıcı açık kalır.
- Sohbetin üstündeki bilgisayar düğmesinden ya da sağ paneldeki "Bilgisayar" bölümünden botun ekranı
  canlı izlenir. "Kontrolü al" ile tarayıcıyı siz kullanırsınız (giriş, doğrulama kodu gibi); bu sırada bot
  bekler, pencereyi kapatınca kontrol bota geri döner.
- Tarayıcıyı yalnızca interneti açık botlar kullanır (bot ayarlarında "İnternet erişimi"). Bot siteleri
  sormadan açar; bir şey gönderen, satın alan, silen ya da paylaşan bir adımdan önce onay kartı gösterir.
  Yalnızca `http` ve `https` adresleri açılır.
- Chromium'un kendi yalıtımı (sandbox) açıktır; Bash yalıtımıyla aynı kullanıcı ad alanı izinlerine
  dayanır. Çalışmadığı bir ortamda `YUMAKBOT_BROWSER_SANDBOX=0` ile kapatılabilir; o zaman web sayfaları
  yalnızca kapsayıcının sınırlarıyla korunur.

### Şifre kasası

Bir siteye giriş gerektiğinde bot sohbette bir giriş kartı açar; kullanıcı adı ve şifreyi siz yazarsınız,
sunucu bunları doğrudan o siteye yazar. Bot şifreyi hiç görmez: sayfa taslağında şifre alanlarının ve
kasadaki şifrelerin yeri `••••••` olarak gelir. "Kasaya kaydet" seçilirse bilgi Ayarlar → Kasa'da durur ve
bir dahaki girişte kart açılmaz. Kayıtlı bir giriş yalnızca kaydedildiği siteye ve alt alan adlarına
yazılır.

Şifreler veritabanında AES-256-GCM ile şifrelenir; anahtar `/data/vault.key` dosyasındadır. Yedek alırken
bu dosyayı da alın: anahtar olmadan kasadaki şifreler açılamaz. Veritabanı yedeğini anahtardan ayrı
saklamak, yedek ele geçse de şifreleri korur.

Masaüstü uygulamasında ayrıca kurulum gerekmez: bilgisayarda kurulu Chrome, Edge ya da Chromium bulunur
ve botlar onu kendi ayrı profilleriyle kullanır. Durum Ayarlar → Bağlantı → "Botların tarayıcısı"
satırında görünür.

## Bash yalıtımı

Claude botlarının Bash komutları kapsayıcının içinde ayrıca bir yalıtımda (bubblewrap) çalışır. Bu ikinci
kat gereklidir: bütün botlar aynı `/data` klasörünü paylaşır ve orada Claude girişi, erişim anahtarı ve
öteki botların dosyaları durur. Yalıtımın içindeki komut yalnızca kendi botunun klasörlerini görür; kendi
süreç ad alanında çalıştığı için sunucunun ve kapsayıcının süreçlerini (ve ortam değişkenlerini) de görmez.
Yalıtım kurulamazsa sunucu komutu yalıtımsız çalıştırmaz.

bubblewrap'in kapsayıcıda çalışması için `compose.yml` iki ayar verir:

- `seccomp=./seccomp.json`: Docker'ın varsayılan seccomp profili, artı kullanıcı ad alanı ve bağlama için
  beş çağrı (`clone`, `unshare`, `mount`, `umount2`, `pivot_root`). Öteki bütün kurallar varsayılandaki
  gibidir. Dosyayı yeniden üretmek için: `node docker/seccomp.mjs`. Varsayılan profil Docker'ın
  `moby/profiles` deposundandır (Apache-2.0).
- `systempaths=unconfined`: Docker'ın `/proc` üzerindeki maskelerini kaldırır; bubblewrap yalıtıma yeni bir
  `/proc` bağlayabilsin diye. Sunucu root olmayan kullanıcıyla, bütün yetkiler kapalı ve `no-new-privileges`
  ile çalıştığı için maskelerin koruduğu çekirdek dosyalarına (ör. `/proc/sysrq-trigger`, `/proc/kcore`)
  yine yazamaz ve onları okuyamaz.

Bedeli: kapsayıcının içindeki süreçler kullanıcı ad alanı açabilir; bu, çekirdeğin daha geniş bir yüzeyini
kullanıma açar. Kapsayıcının kendi sınırları (root olmayan kullanıcı, bütün yetkiler kapalı,
`no-new-privileges`, salt okunur kök) yerinde kalır; gevşeyen yalnızca şunlardır:

| Ayar                                      | Neden gerekli                                                                                                                                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seccomp.json`: `clone`, `unshare`        | Yalıtımın kendi kullanıcı, süreç ve bağlama ad alanları                                                                                                                                                          |
| `mount`, `umount2`, `pivot_root`          | Yalıtımın dosya sistemini (yalnızca botun klasörleri) kurmak                                                                                                                                                     |
| `chroot`                                  | Chromium'un kendi yalıtımı                                                                                                                                                                                       |
| `systempaths=unconfined`                  | Yalıtım kendi süreç ad alanına yeni bir `/proc` bağlar; çekirdek bunu, kapsayıcının `/proc`'unun bir kısmı Docker'ın maskeleriyle örtülüyken reddeder. Eski `/proc`'u kullanmak sunucunun süreçlerini gösterirdi |
| AppArmor `unconfined` / `yumakbot-userns` | `docker-default` bağlamaları reddeder; aşağıya bakın                                                                                                                                                             |

Bağlamaları tek tek sayan daraltılmış bir AppArmor profili verilmedi: bubblewrap'in yaptığı bağlamalar
sürümden sürüme değişir ve profil denenmeden gönderilirse yalıtım, dolayısıyla Claude botlarının Bash'i,
sessizce çalışmaz olur. Yalıtım yine de bu katmanlardan bağımsız olarak botu kendi klasörlerine sınırlar.

Ana makine için öneriler:

- Çekirdeği güncel tutun (Ubuntu ve Debian'da `unattended-upgrades`) ve güncellemeden sonra yeniden başlatın;
  kullanıcı ad alanları üzerinden gelen açıkların çoğu çekirdek güncellemesiyle kapanır.
- Yumak Bot'u, güvenmediğiniz ya da çok önemli başka işlerle aynı sunucuda değil, kendi sanal sunucusunda
  çalıştırın.
- Ubuntu 23.10 ve sonrasında `kernel.apparmor_restrict_unprivileged_userns=1` ayarını açık bırakın:
  `yumakbot-userns` profili yalnızca bu iki kapsayıcıya izin verir, ana makinedeki öteki programlar kısıtlı
  kalır. Kullanıcı ad alanlarını çekirdekte tümden kapatmak (`user.max_user_namespaces=0`) bu kapsayıcılardaki
  yalıtımı da durdurur.

Durumu Ayarlar → Bağlantı → "Bash yalıtımı" satırında görürsünüz; sunucu açılışta yalıtımı dener ve
çalışmazsa nedenini yazar.

### AppArmor

Docker'ın varsayılan AppArmor profili (`docker-default`) bağlama çağrılarını reddeder; AppArmor'lu bir
sunucuda "Bash yalıtımı" satırı "Çalışmıyor" gösterir ve Claude botları Bash çalıştıramaz. Ubuntu 23.10 ve
sonrası ayrıca kullanıcı ad alanlarını AppArmor ile kısıtlar (`kernel.apparmor_restrict_unprivileged_userns=1`);
bu kısıt profilsiz (`unconfined`) süreçlere de uygulanır, yani `apparmor=unconfined` yetmez.

`apparmor.sh` ana makineye bakıp `YUMAKBOT_APPARMOR` değerini seçer; ana makinede root olarak bir kez
çalıştırın, yeniden çalıştırmak zarar vermez:

```bash
sudo ./docker/apparmor.sh --env docker/.env
docker compose -f docker/compose.yml --env-file docker/.env up -d
```

| Ana makine                                                            | Değer             | Betiğin yaptığı                     |
| --------------------------------------------------------------------- | ----------------- | ----------------------------------- |
| AppArmor kapalı                                                       | (yok)             | Hiçbir şey; satırı siler            |
| AppArmor açık, kullanıcı ad alanı kısıtı yok (ör. Debian 12)          | `unconfined`      | Değeri yazar                        |
| AppArmor kullanıcı ad alanlarını kısıtlıyor (Ubuntu 23.10 ve sonrası) | `yumakbot-userns` | Profili kurar, yükler, değeri yazar |

`yumakbot-userns`, `yumakbot` ve `computer` kapsayıcılarına yalnızca kullanıcı ad alanı izni veren profildir
(`docker/apparmor/yumakbot-userns`); `/etc/apparmor.d/` altına kurulur ve yeniden başlatmadan sonra da yüklü
kalır. Profil AppArmor 4 ister (Ubuntu 24.04); yüklü değilken bu değer verilirse kapsayıcı başlamaz.
Kullanıcı ad alanları çekirdekte kapalıysa betik bunu ve nasıl açılacağını söyler. `--env` verilmezse betik
değeri yalnızca yazdırır; `--remove` profili kaldırır.

Profil Ubuntu 24.04'te denendi. SELinux'un kapsayıcı politikası da bubblewrap'i engelleyebilir; SELinux'lu
bir sunucuda denenmedi.

#### Dokploy ve benzeri paneller

Panel her yayında depoyu yeniden indirir ve `docker/.env` dosyasını kendi ayarlarından yeniden yazar; bu
yüzden `--env` kullanmayın. Sunucuya SSH ile bağlanıp betiği panelin indirdiği kopyadan çalıştırın
(Dokploy'da `/etc/dokploy/compose/<uygulama>/code`):

```bash
sudo /etc/dokploy/compose/<uygulama>/code/docker/apparmor.sh
```

Betiğin yazdırdığı `YUMAKBOT_APPARMOR=…` satırını panelde uygulamanın ortam değişkenlerine (Dokploy'da
Environment) ekleyip yeniden yayınlayın. Profil `/etc/apparmor.d/` altında durduğu için yeni yayınlar onu
silmez.

Yayın `networks have same bridge name` hatasıyla durursa bu sunucuda `yumakbot0` köprüsünü kullanan başka
bir ağ vardır: çoğunlukla aynı sunucudaki önceki bir kurulumdan ya da panelde silinip yeniden açılmış bir
uygulamadan kalmıştır. Panel her uygulamaya kendi proje adını verdiği için ağ adları farklıdır, ama köprü
adı güvenlik duvarı onu bulabilsin diye sabittir. Hangi ağın tuttuğunu görmek için:

```bash
docker network ls -q | xargs docker network inspect -f '{{.Name}} {{index .Options "com.docker.network.bridge.name"}} {{len .Containers}}' | grep yumakbot0
```

Ağ eski bir kurulumdan kaldıysa ve kapsayıcısı yoksa (son sayı 0) `docker network rm <ad>` ile silip yeniden
yayınlayın. İki kurulumu aynı sunucuda birlikte çalıştırmak istiyorsanız ikincisine panelde
`YUMAKBOT_BRIDGE=yumakbot1` gibi başka bir ad verin (en çok 15 karakter). Öteki kurulum `127.0.0.1:4319`'u
tuttuğu için `YUMAKBOT_PORT=4329` gibi başka bir port da verin; panelde alan adının hedef portu `4319` kalır.

Panel güvenlik duvarını kurmaz. Yayından sonra her kurulum için, kendi köprüsüyle, bir kez:

```bash
sudo BRIDGE=yumakbot0 /etc/dokploy/compose/<uygulama>/code/docker/firewall.sh
```

Kurallar köprüye göre eklenir; iki kurulumun kuralları birbirini silmez, başka kapsayıcıların trafiğine de
dokunmaz. Yeniden başlatmadan sonra da kalmaları için her kuruluma bir servis yazın; Docker yeniden
başladığında da çalışır, panel yeniden yayınlayınca köprü aynı adla geri geldiği için kurallar geçerli kalır:

```bash
sudo tee /etc/systemd/system/yumakbot-firewall-<uygulama>.service <<'EOF'
[Unit]
Description=Yumak Bot egress firewall (<uygulama>)
After=docker.service
Requires=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=BRIDGE=yumakbot0
ExecStart=/bin/sh /etc/dokploy/compose/<uygulama>/code/docker/firewall.sh --wait

[Install]
WantedBy=multi-user.target docker.service
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now yumakbot-firewall-<uygulama>.service
```

Uygulamayı panelden silerseniz servisini de kaldırın (`systemctl disable --now …` ve dosyayı silin); yoksa
açılışta betiği bulamaz ve başarısız görünür.

Panelde bir alan adı bağlanınca Dokploy `yumakbot` servisini kendi `dokploy-network` ağına ve projenin
`default` ağına da ekler. Sunucu kapsayıcısı internete artık bu ağlardan çıkar, `egress` köprüsünden değil;
bu yüzden güvenlik duvarı burada yalnızca `computer` kapsayıcısını (botların masaüstlerini) korur. Sunucu
kapsayıcısı ayrıca `dokploy-network` üzerinden paneldeki öteki uygulamalara (Dokploy'un kendi veritabanı
dahil) ulaşabilir. Botların komutları buna rağmen kapalı kalır: internet açık bir botun komutları sunucunun
kendi vekilinden geçer ve o vekil yalnızca genel adreslere bağlanır.

## Botların bilgisayarı

Her botun kendi Linux masaüstü oturumu vardır: panel, tarayıcı, terminal, dosya yöneticisi, LibreOffice ve
metin düzenleyici. Oturumlar `computer` kapsayıcısında çalışır; sunucu ona HTTP ile ve WebSocket ile
bağlanır. Her oturum ayrı bir bubblewrap yalıtımındadır: kendi ekranı, kendi süreçleri ve kendi ana
klasörü vardır, yalnızca botun klasörlerini görür. Başka botların dosyalarını ve `computer` kapsayıcısının
ortam değişkenlerini (erişim belirteci dahil) görmez.

Kurulum için `.env` dosyasına `YUMAKBOT_COMPUTER_TOKEN` yazın (en az 32 karakter; `openssl rand -hex 32`).
Sunucu ile `computer` kapsayıcısı bu değerle birbirini tanır; `computer` ağı yalnızca bu ikisini bağlar ve
dışarı çıkışı yoktur.

- **Docker Engine 26 ya da üstü gerekir.** `computer` kapsayıcısı `data` birimindeki yalnızca `workspaces`
  klasörünü bağlar (`volume.subpath`); eski sürümlerde bu seçenek tanınmaz. Klasörü sunucu ilk açılışta
  oluşturur; bu yüzden `computer` kapsayıcısı sunucu sağlıklı olduktan sonra başlar.
- **Kaynak kullanımı:** boştaki bir masaüstü yaklaşık 70–140 MB bellek tutar, açık bir tarayıcı yaklaşık 200 MB
  daha ekler. Kapsayıcı en çok 6 GB belleğe ve 3 işlemciye sınırlıdır; aynı anda en çok 3 masaüstü
  çalışır (`YUMAKBOT_COMPUTER_MAX`). Sınır dolunca yeni masaüstü açılmaz.
- **Masaüstlerinin interneti açıktır.** Oturumlar kapsayıcının ağını paylaşır, yani `firewall.sh`
  kuralları onlar için de geçerlidir. Bir oturumun ekranına başka bir oturum bağlanamaz (her ekranın
  kendi X yetki çerezi vardır), ama ağ düzeyinde oturumlar birbirinden ayrı değildir.
- **Masaüstünü yalnızca interneti açık botlar kullanır.** Bot ayarlarında "İnternet erişimi" kapalı olan
  bota masaüstü verilmez; komutları sunucunun yalıtımında, internete çıkmadan çalışır. Masaüstündeki
  her komut yine botun izin ayarlarına göre sorulur.
- Oturumun içindeki Chromium'un kendi yalıtımı açıktır; bunun için `seccomp.json` ayrıca `chroot` çağrısına
  izin verir (Docker'ın varsayılanı bunu yalnızca `CAP_SYS_CHROOT` ile verir). Kapsayıcının `/proc`
  maskeleri `systempaths=unconfined` ile Bash yalıtımındaki gibi kaldırılır.
- Masaüstü oturumları kapsayıcı yeniden başlayınca kapanır; botların ana klasörleri ve dosyaları
  `data` biriminde kalır.
- **GitHub, git rölesi üzerinden.** Masaüstlerinde git, pnpm ve yarn (corepack) kuruludur. Oturumdaki git
  `github.com` adreslerini kapsayıcının `127.0.0.1:4322` adresindeki röleye gönderir
  (`YUMAKBOT_COMPUTER_GIT_PORT`); röle, bota açık ve `https://github.com` için kaydedilmiş API anahtarını
  isteğe ekler. Anahtar oturuma hiç girmez. Röle yalnızca git isteklerini ve yalnızca GitHub'a geçirir;
  deponun varsayılan dalına push'u reddeder. Oturumlar ağı paylaştığı için her oturumun röle adresinde
  kendine ait rastgele bir anahtar vardır.

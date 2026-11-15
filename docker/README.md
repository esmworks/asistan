# Yumak Bot'u sunucuda çalıştırma (Docker)

```bash
cp docker/.env.example docker/.env      # değerleri doldurun
sudo ./docker/apparmor.sh --env docker/.env   # Linux ana makinede, bir kez; bkz. "AppArmor"
docker compose -f docker/compose.yml --env-file docker/.env up -d --build
sudo ./docker/firewall.sh               # Linux ana makinede, compose'dan sonra
```

Sunucu yalnızca ana makinenin `127.0.0.1:4319` adresinde dinler. Uzaktan erişim için önüne TLS veren bir ters
vekil (Caddy, nginx) koyun, `YUMAKBOT_ALLOWED_HOSTS` değerine alan adını, `YUMAKBOT_SECURE_COOKIES=1` yazın.

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
kullanıma açar. Ana makinenin çekirdeğini güncel tutun.

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

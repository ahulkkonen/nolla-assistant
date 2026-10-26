"""Build tests/pii/corpus.jsonl from the hand-written source below.

Markup inside a line:
  {{surface|K|canonical|ref|note}}  gold span (fields after K are optional, empty means default)
  {{surface|!K|note}}               decoy: looks like K but is not PII (goes to "decoys", not "spans")
K: P=PERSON H=HETU I=IBAN T=PHONE A=ADDRESS Z=POSTCODE_CITY R=PLATE E=EMAIL O=ORG
Line format: "tag,tag :: text"; "\\n" in text is a newline. Lines starting with "#" are comments.
Every line is hand-written; codes come from a seeded Python run (see validate.py for the checks).

Run: python3 -I tests/pii/generate.py
"""

import json
import re
from pathlib import Path

KINDS = {"P": "PERSON", "H": "HETU", "I": "IBAN", "T": "PHONE", "A": "ADDRESS",
         "Z": "POSTCODE_CITY", "R": "PLATE", "E": "EMAIL", "O": "ORG"}

SRC = r"""
# --- person names in oblique cases, gradation, vowel harmony, clitics, possessives
genitive,inflected :: Lähetätkö {{Mikko Virtasen|P|Mikko Virtanen||genetiivi}} kuitit vielä tänään kirjanpitoon?
genitive,inflected,compound-name :: Kävin eilen {{Anna-Liisa Mäkelän|P|Anna-Liisa Mäkelä||genetiivi}} luona, ja hän tarjosi pullakahvit.
allative,inflected :: Muista soittaa {{Virtaselle|P|Virtanen|Mikko Virtanen|allatiivi, -nen > -se-}} ennen kolmea, hän odottaa vastausta tarjoukseen.
allative,inflected :: Laitoin {{Mäkelälle|P|Mäkelä|Anna-Liisa Mäkelä|allatiivi}} viestin, mutta vastausta ei ole vielä kuulunut.
genitive,inflected,place-vs-surname :: Onko {{Pekka Lahden|P|Pekka Lahti||genetiivi, astevaihtelu t > d}} raportti jo valmis vai odotetaanko vielä?
allative,inflected :: Annoin varaston avaimet {{Tiina Kokolle|P|Tiina Kokko||allatiivi, astevaihtelu kk > k}}, koska hän menee aamulla ensimmäisenä töihin.
genitive,inflected :: {{Jarmo Turkan|P|Jarmo Turkka||genetiivi, astevaihtelu kk > k}} mukaan palaveri siirtyy ensi viikkoon.
ablative,inflected :: Kysyisitkö {{Sanna Hyvöseltä|P|Sanna Hyvönen||ablatiivi, etuvokaalisointu}}, sopiiko torstai paremmin?
partitive,inflected :: En ole nähnyt {{Juhani Korhosta|P|Juhani Korhonen||partitiivi}} sitten kesän, onkohan hän vielä samassa firmassa?
partitive,inflected :: Kaikki odottivat {{Mäkelää|P|Mäkelä|Anna-Liisa Mäkelä|partitiivi}} puoli tuntia, mutta hän jäi ruuhkaan kehätielle.
essive,inflected :: Kirjauduin vahingossa {{Leena Öhmanina|P|Leena Öhman||essiivi}} yhteiselle koneelle, pitää muistaa kirjautua ulos.
essive,inflected,place-vs-surname :: {{Satu Mäki|P|Satu Mäki||nominatiivi}} löytyy rekisteristä vielä nimellä {{Satu Niemi|P|Satu Niemi|Satu Mäki|entinen sukunimi}}, joten haku ei osunut. Hän esiintyi vanhoissa papereissa {{Niemenä|P|Niemi|Satu Mäki|essiivi, entinen sukunimi}}.
translative,inflected,first-name-only :: {{Katja|P|Katja|Katja Lindqvist|etunimi; viittaa samassa rivissä Katja Lindqvistiin}} vaihtoi sukunimensä {{Lindqvistiksi|P|Lindqvist|Katja Lindqvist|translatiivi}} viime keväänä, muista päivittää yhteystiedot.
translative,genitive,inflected :: {{Päivi Järvisen|P|Päivi Järvinen||genetiivi}} entinen sukunimi oli {{Rauhala|P|Rauhala|Päivi Järvinen|entinen sukunimi}}, mutta se muuttui avioliitossa {{Järviseksi|P|Järvinen|Päivi Järvinen|translatiivi}}.
ablative,inessive,inflected,first-name-only :: Kysy asiaa {{Jarmo Turkalta|P|Jarmo Turkka||ablatiivi, kk > k}}. {{Jarmossa|P|Jarmo|Jarmo Turkka|inessiivi; viittaa edellisen lauseen Jarmo Turkkaan}} on se hyvä puoli, että hän vastaa aina heti.
inessive,inflected :: Minusta {{Ville Heikkisessä|P|Ville Heikkinen||inessiivi}} on ainesta tiiminvetäjäksi.
elative,inflected,place-vs-surname :: Tiedätkö mitään {{Pekka Lahdesta|P|Pekka Lahti||elatiivi, t > d}}? Hän ei ole vastannut viesteihin viikkoon.
elative,inflected,swedish-finnish :: Pidän {{Öhmanista|P|Öhman|Leena Öhman|elatiivi}} kovasti, hän on reilu esihenkilö.
illative,inflected,swedish-finnish :: Otin yhteyttä {{Erik Åkerlundiin|P|Erik Åkerlund||illatiivi}} sähköpostilla, katsotaan mitä hän vastaa.
illative,inflected,double-surname :: Luotan {{Riikka Virtanen-Koskiseen|P|Riikka Virtanen-Koskinen||illatiivi, kaksoissukunimi}} täysin tässä asiassa.
adessive,inflected :: {{Tiina Kokolla|P|Tiina Kokko||adessiivi, kk > k}} on varaston avaimet, joten kysy häneltä.
adessive,inflected :: Oliko {{Juhani Korhosella|P|Juhani Korhonen||adessiivi}} vielä se peräkärry lainassa?
abessive,inflected :: Kokous pidettiin tällä kertaa {{Virtasetta|P|Virtanen|Mikko Virtanen|abessiivi}}, joten isoja päätöksiä ei tehty.
abessive,inflected,first-name-only :: {{Matti Laine|P|Matti Laine||nominatiivi}} on ensi viikon lomalla. Pärjäättekö te viikon {{Matitta|P|Matti|Matti Laine|abessiivi, tt > t; viittaa edellisen lauseen Matti Laineeseen}}?
comitative,inflected,first-name-only :: {{Heikki Nieminen|P}} ja {{Päivi Järvinen|P}} asuvat naapurissa. {{Päivi|P|Päivi|Päivi Järvinen|etunimi; viittaa edellisen lauseen Päivi Järviseen}} tuli eilen grillijuhliin {{Heikkeineen|P|Heikki|Heikki Nieminen|komitatiivi; viittaa edellisen lauseen Heikki Nieminen}} ja toi perunasalaattia.
comitative,inflected,first-name-only :: {{Ville Heikkinen|P}} ja {{Tiina Hämäläinen|P}} muuttivat yhteen keväällä. {{Tiina|P|Tiina|Tiina Hämäläinen|etunimi; viittaa edellisen lauseen Tiina Hämäläiseen}} saapui sukujuhliin {{Villeineen|P|Ville|Ville Heikkinen|komitatiivi; viittaa edellisen lauseen Ville Heikkiseen}}, ja mummo ilahtui kovasti.
instructive,inflected :: Juhannus vietetään taas kaikin {{Korhosin|P|Korhonen|Juhani Korhonen|instruktiivi monikko, leikillinen}}, eli myös {{Juhani Korhonen|P}} veljineen tulee.
instructive,inflected,genitive :: Mökkitalkoisiin mennään tänä vuonna vain kaksin {{Virtasin|P|Virtanen|Mikko Virtanen|instruktiivi monikko, leikillinen}}, koska {{Mikko Virtasen|P|Mikko Virtanen||genetiivi}} veli on reissussa.
accusative :: Kutsuin {{Mikko Virtasen|P|Mikko Virtanen||akkusatiivi}} lauantaina saunailtaan.
accusative,inflected,swedish-finnish :: Tapasin {{Leena Öhmanin|P|Leena Öhman||akkusatiivi}} aamulla ratikassa, ja hän kysyi sinun kuulumisiasi.
accusative,swedish-finnish :: Valitsimme {{Katja Lindqvistin|P|Katja Lindqvist||akkusatiivi}} taloyhtiön hallituksen puheenjohtajaksi.
possessive,nickname :: {{Matti Laine|P}} lupasi tulla kuudelta. Missä se teidän {{Masanne|P|Masa|Matti Laine|lempinimi + possessiivisuffiksi -nne; viittaa edellisen lauseen Matti Laineeseen}} nyt viipyy?
possessive,first-name-only :: {{Tiina Kokko|P}} lähti töistä jo neljältä. Onko {{Tiinasi|P|Tiina|Tiina Kokko|possessiivisuffiksi -si; viittaa edellisen lauseen Tiina Kokkoon}} jo kotona?
possessive,first-name-only,double-surname :: {{Riikka Virtanen-Koskinen|P}} on isosiskoni. {{Riikkani|P|Riikka|Riikka Virtanen-Koskinen|possessiivisuffiksi -ni; viittaa edellisen lauseen Riikka Virtanen-Koskiseen}} on aina ollut meistä se järkevin.
clitic,allative,inflected :: Laita juhlakutsu {{Virtasellekin|P|Virtanen|Mikko Virtanen|allatiivi + -kin}}, vaikka hän ei viime vuonna päässyt.
clitic,allative,inflected,place-vs-surname :: Soititko {{Pekka Lahdellekin|P|Pekka Lahti||allatiivi + -kin, t > d}} vai pitääkö minun hoitaa se?
clitic :: {{Mäkeläkö|P|Mäkelä|Anna-Liisa Mäkelä|nominatiivi + -kö, etuvokaalisointu}} sen tilauksen teki, vai joku muu?
clitic,genitive,inflected :: {{Sanna Hyvösenhän|P|Sanna Hyvönen||genetiivi + -hän}} piti hoitaa tämä jo viime viikolla.
clitic :: {{Juhani Korhonenko|P|Juhani Korhonen||nominatiivi + -ko}} sen sanoi, vai muistanko väärin?
clitic,genitive,inflected,place-vs-surname :: {{Pekka Lahdenhan|P|Pekka Lahti||genetiivi + -han, t > d}} piti tuoda kakku, joten älä osta toista.
genitive,inflected :: {{Tiina Kokon|P|Tiina Kokko||genetiivi, kk > k}} auto on huollossa, joten hän tulee bussilla.
illative,inflected :: Törmäsin {{Jarmo Turkkaan|P|Jarmo Turkka||illatiivi}} kaupan kassajonossa.
allative,inflected :: Välitätkö terveiset {{Sanna Hyvöselle|P|Sanna Hyvönen||allatiivi, etuvokaalisointu}}?
ablative,inflected,swedish-finnish :: Sain {{Katja Lindqvistiltä|P|Katja Lindqvist||ablatiivi}} hyvän vinkin hammaslääkäristä.
allative,inflected,swedish-finnish :: Muistuta {{Erik Åkerlundille|P|Erik Åkerlund||allatiivi}}, että vuokra erääntyy perjantaina.
adessive,inflected,swedish-finnish :: {{Leena Öhmanilla|P|Leena Öhman||adessiivi}} on huomenna etäpäivä.
partitive,inflected :: Pyydä {{Ville Heikkistä|P|Ville Heikkinen||partitiivi}} tarkistamaan budjetti ennen kuin lähetät sen.
genitive,inflected,double-surname :: {{Riikka Virtanen-Koskisen|P|Riikka Virtanen-Koskinen||genetiivi}} puhelinnumero on vaihtunut, päivitä se.
ablative,inflected :: Kuulin {{Heikki Niemiseltä|P|Heikki Nieminen||ablatiivi}}, että taloyhtiön remontti alkaa syyskuussa.
allative,inflected :: Lähetä lasku {{Tuomas Lehtoselle|P|Tuomas Lehtonen||allatiivi}} ja kopio minulle.
genitive,inflected :: {{Minna Rantasen|P|Minna Rantanen||genetiivi}} lapset ovat samalla luokalla kuin meidän poika.
partitive,inflected :: Onnittele {{Jukka Salmista|P|Jukka Salminen||partitiivi}} ylennyksestä, jos näet hänet tänään.
adessive,inflected :: {{Outi Kalliolla|P|Outi Kallio||adessiivi}} on kokemusta juuri tällaisista hankkeista.
allative,inflected :: Kirjoita {{Petri Kärkkäiselle|P|Petri Kärkkäinen||allatiivi, etuvokaalisointu}} kiitoskortti.
ablative,inflected :: Kysy {{Henna Leppäseltä|P|Henna Leppänen||ablatiivi}}, löytyykö häneltä vielä niitä kangaskasseja.
genitive,inflected :: {{Noora Väisäsen|P|Noora Väisänen||genetiivi}} hääkutsu tuli tänään postissa.
illative,inflected :: Ihastuin {{Eero Pöyhöseen|P|Eero Pöyhönen||illatiivi}} jo ensimmäisellä tapaamisella.
essive,inflected,swedish-finnish :: Muistan hänet vielä {{Kaisa Björklundina|P|Kaisa Björklund||essiivi}}, ennen kuin hän otti miehensä nimen.
allative,inflected,swedish-finnish :: Laitoin {{Tapio Söderströmille|P|Tapio Söderström||allatiivi}} tekstarin, että myöhästyn vähän.
ablative,inflected,swedish-finnish :: Sain {{Emma Grönroosilta|P|Emma Grönroos||ablatiivi}} reseptin siihen mustikkapiirakkaan.
genitive,inflected,swedish-finnish :: {{Lauri Österbergin|P|Lauri Österberg||genetiivi}} vene on vielä telakalla.
partitive,inflected :: Ehdotin {{Veera Kettusta|P|Veera Kettunen||partitiivi}} uudeksi rahastonhoitajaksi.
elative,inflected :: Pidätkö {{Arto Pitkäsestä|P|Arto Pitkänen||elatiivi}} vai onko hän mielestäsi liian jyrkkä?
abessive,inflected :: Emme pärjää {{Hyvösettä|P|Hyvönen|Sanna Hyvönen|abessiivi, etuvokaalisointu}} tässä projektissa, sano se hänelle.
genitive,inflected :: Ilmoittauduin {{Ilkka Ahosen|P|Ilkka Ahonen||genetiivi}} vetämälle kurssille, vaikka se oli jo melkein täynnä.
# --- first-name-only mentions, each with the full name earlier in the same text
first-name-only :: {{Sanna Hyvönen|P}} soitti aamulla. {{Sanna|P|Sanna|Sanna Hyvönen|etunimi; viittaa edellisen lauseen Sanna Hyvöseen}} haluaa siirtää hammaslääkärin torstaille.
first-name-only,adessive,swedish-finnish :: Kokouksessa olivat {{Mikko Virtanen|P}} ja {{Erik Åkerlund|P}}. {{Mikolla|P|Mikko|Mikko Virtanen|adessiivi, kk > k; viittaa Mikko Virtaseen}} oli hyviä ideoita, {{Erik|P|Erik|Erik Åkerlund|etunimi; viittaa Erik Åkerlundiin}} oli hiljaa.
first-name-only,allative,compound-name :: Muistutus: {{Anna-Liisa Mäkelä|P}} täyttää 50 ensi kuussa. Osta {{Anna-Liisalle|P|Anna-Liisa|Anna-Liisa Mäkelä|allatiivi; viittaa edellisen lauseen Anna-Liisa Mäkelään}} kukkia.
first-name-only,ablative,place-vs-surname :: {{Pekka Lahti|P}} on uusi tiiminvetäjä. Kysy {{Pekalta|P|Pekka|Pekka Lahti|ablatiivi, kk > k; viittaa edellisen lauseen Pekka Lahteen}}, jos lomakkeen kanssa on ongelmia.
first-name-only,allative :: {{Tiina Kokko|P}} on tänään etänä. Lähetä {{Tiinalle|P|Tiina|Tiina Kokko|allatiivi; viittaa edellisen lauseen Tiina Kokkoon}} linkki palaveriin.
first-name-only,accusative,genitive :: Tapasin {{Jarmo Turkan|P|Jarmo Turkka||akkusatiivi}} salilla. {{Jarmon|P|Jarmo|Jarmo Turkka|genetiivi; viittaa edellisen lauseen Jarmo Turkkaan}} polvi on kuulemma jo parempi.
first-name-only,allative,swedish-finnish :: {{Katja Lindqvist|P}} kysyi lainaan porakonetta. Voitko viedä sen {{Katjalle|P|Katja|Katja Lindqvist|allatiivi; viittaa edellisen lauseen Katja Lindqvistiin}} illalla?
first-name-only,allative,swedish-finnish :: {{Leena Öhman|P}} jää eläkkeelle joulukuussa. Kerätään {{Leenalle|P|Leena|Leena Öhman|allatiivi; viittaa edellisen lauseen Leena Öhmaniin}} yhteinen lahja.
first-name-only,allative :: Ilmoitin {{Heikki Niemiselle|P|Heikki Nieminen||allatiivi}}, että myöhästyn. {{Heikki|P|Heikki|Heikki Nieminen|etunimi; viittaa edellisen lauseen Heikki Niemiseen}} sanoi, ettei se haittaa.
first-name-only,partitive :: {{Ville Heikkinen|P}} hoitaa grillin ja {{Päivi Järvinen|P}} salaatit. Muistuta {{Villeä|P|Ville|Ville Heikkinen|partitiivi; viittaa edellisen lauseen Ville Heikkiseen}} hiilistä.
first-name-only,genitive :: Hammaslääkäri soitti {{Päivi Järvisen|P|Päivi Järvinen||genetiivi}} puolesta. {{Päivin|P|Päivi|Päivi Järvinen|genetiivi; viittaa edellisen lauseen Päivi Järviseen}} aika siirtyi ensi tiistaille.
first-name-only,genitive,place-vs-surname :: {{Johanna Salo|P}} on uusi naapurimme. {{Johannan|P|Johanna|Johanna Salo|genetiivi; viittaa edellisen lauseen Johanna Saloon}} koira haukkuu aamuisin, mutta muuten hän vaikuttaa mukavalta.
first-name-only,adessive,place-vs-surname :: Tee muistiinpano: {{Antti Niemi|P}} hoitaa kaavoituksen. {{Antilla|P|Antti|Antti Niemi|adessiivi, tt > t; viittaa edellisen lauseen Antti Niemeen}} on kaikki piirustukset.
first-name-only,genitive,place-vs-surname :: {{Marja Saari|P}} lähetti tarjouksen. {{Marjan|P|Marja|Marja Saari|genetiivi; viittaa edellisen lauseen Marja Saareen}} hinta oli selvästi muita halvempi.
first-name-only,allative,place-vs-surname :: {{Kari Ranta|P}} on sairaslomalla. Toivota {{Karille|P|Kari|Kari Ranta|allatiivi; viittaa edellisen lauseen Kari Rantaan}} pikaista paranemista.
first-name-only,allative,place-vs-surname :: {{Elina Järvi|P}} kysyi, mahtuuko hän kyytiin. Sano {{Elinalle|P|Elina|Elina Järvi|allatiivi; viittaa edellisen lauseen Elina Järveen}}, että mahtuu.
first-name-only,place-vs-surname :: {{Timo Koski|P}} vastaa huoltosopimuksesta. Onko {{Timo|P|Timo|Timo Koski|etunimi; viittaa edellisen lauseen Timo Koskeen}} jo lähettänyt sen allekirjoitettuna?
first-name-only,genitive :: Luin {{Outi Kallion|P|Outi Kallio||genetiivi}} raportin. {{Outin|P|Outi|Outi Kallio|genetiivi; viittaa edellisen lauseen Outi Kallioon}} johtopäätökset ovat mielestäni oikeat.
first-name-only :: {{Sami Toivonen|P}} ja {{Kirsi Lahtinen|P}} pitävät koulutuksen. {{Kirsi|P|Kirsi|Kirsi Lahtinen|etunimi; viittaa edellisen lauseen Kirsi Lahtiseen}} aloittaa, ja {{Sami|P|Sami|Sami Toivonen|etunimi; viittaa edellisen lauseen Sami Toivoseen}} jatkaa lounaan jälkeen.
first-name-only,partitive :: {{Reijo Karjalainen|P}} toi meille omenamehua. Kiitä {{Reijoa|P|Reijo|Reijo Karjalainen|partitiivi; viittaa edellisen lauseen Reijo Karjalaiseen}}, kun näet hänet.
first-name-only,genitive :: {{Irma Tähtinen|P}} täyttää 90 vuotta. {{Irman|P|Irma|Irma Tähtinen|genetiivi; viittaa edellisen lauseen Irma Tähtiseen}} syntymäpäivät ovat lauantaina kello 14.
first-name-only,clitic :: {{Hanna Siltanen|P}} voitti taas arvonnan. {{Hannahan|P|Hanna|Hanna Siltanen|nominatiivi + -han; viittaa edellisen lauseen Hanna Siltaseen}} on aina onnekas!
first-name-only,allative :: {{Noora Väisänen|P}} on lomalla Kreetalla. Kirjoitan {{Nooralle|P|Noora|Noora Väisänen|allatiivi; viittaa edellisen lauseen Noora Väisäseen}}, kun hän palaa.
# --- nicknames
nickname :: {{Matti Laine|P}} soitti äsken. {{Masa|P|Masa|Matti Laine|lempinimi; viittaa edellisen lauseen Matti Laineeseen}} tulee hakemaan peräkärryn huomenna.
nickname,translative :: {{Juhani Korhonen|P}} on ollut kerhossa mukana alusta asti, ja kaikki kutsuvat häntä {{Jussiksi|P|Jussi|Juhani Korhonen|lempinimi, translatiivi; viittaa samassa lauseessa Juhani Korhoseen}}.
nickname,allative,genitive :: {{Juhani Korhosen|P|Juhani Korhonen||genetiivi}} lento on myöhässä. Kerro {{Jussille|P|Jussi|Juhani Korhonen|lempinimi, allatiivi; viittaa edellisen lauseen Juhani Korhoseen}}, että haen hänet kentältä vasta kuudelta.
nickname :: {{Petri Kärkkäinen|P}} hoitaa nettisivut. {{Pete|P|Pete|Petri Kärkkäinen|lempinimi; viittaa edellisen lauseen Petri Kärkkäiseen}} sanoi, että ne ovat valmiit perjantaina.
nickname :: {{Heikki Nieminen|P}} eli {{Hessu|P|Hessu|Heikki Nieminen|lempinimi; viittaa samassa lauseessa Heikki Niemiseen}} tuli taas puoli tuntia myöhässä.
nickname,allative :: {{Tuomas Lehtonen|P}} lähtee vaihtoon Saksaan. Pidetään {{Tumpille|P|Tumppi|Tuomas Lehtonen|lempinimi, allatiivi, pp > p; viittaa edellisen lauseen Tuomas Lehtoseen}} läksiäiset perjantaina.
nickname,place-vs-surname :: {{Timo Koski|P}} voitti firman tikkakisan. {{Timppa|P|Timppa|Timo Koski|lempinimi; viittaa edellisen lauseen Timo Koskeen}} on harjoitellut koko talven.
nickname,genitive,place-vs-surname :: Sovin {{Johanna Salon|P|Johanna Salo||genetiivi}} kanssa lounaasta. {{Jonna|P|Jonna|Johanna Salo|lempinimi; viittaa edellisen lauseen Johanna Saloon}} varaa pöydän.
nickname,double-surname :: {{Riikka Virtanen-Koskinen|P}} lähettää kuvat illalla. {{Riksu|P|Riksu|Riikka Virtanen-Koskinen|lempinimi; viittaa edellisen lauseen Riikka Virtanen-Koskiseen}} on aina tarkka näistä.
nickname,adessive,place-vs-surname :: {{Antti Niemi|P}} lupasi auttaa muutossa. {{Antsalla|P|Antsa|Antti Niemi|lempinimi, adessiivi; viittaa edellisen lauseen Antti Niemeen}} on pakettiauto.
nickname,allative,place-vs-surname :: {{Kari Ranta|P}} on vähän poissa tolaltaan. Soita {{Kakelle|P|Kake|Kari Ranta|lempinimi, allatiivi; viittaa edellisen lauseen Kari Rantaan}} illalla.
# --- hetu
genitive :: {{Mikko Virtasen|P|Mikko Virtanen||genetiivi}} henkilötunnus on {{210165-076K|H}}, tarvitsen sitä vakuutushakemukseen.
:: Täytä lomakkeeseen hetu: {{190163-5214|H}} ja nimi {{Juhani Korhonen|P}}.
:: Apteekki kysyi henkilötunnusta, annoin {{140745-073M|H}}, mutta reseptiä ei löytynyt.
:: Kirjoitin vahingossa ryhmächattiin hetuni {{211154-598M|H}}. Voiko viestin vielä poistaa?
:: Isän hetu on {{130177-228D|H}} ja äidin {{050594-431D|H}}, tarvitaan molemmat.
:: {{Kela|O}} pyytää hakemukseen hakijan henkilötunnuksen ({{190547-575Y|H}}) ja tilinumeron.
:: Pojan henkilötunnus on {{191103A1945|H}}, hän syntyi marraskuussa 2003.
:: Lasten tiedot päiväkotia varten:\n{{Aino Virtanen|P}}, {{230203A579W|H}}\n{{Onni Virtanen|P}}, {{161119A546P|H}}
:: Tyttären henkilötunnus on {{190810A3729|H}}, hän aloittaa lukion syksyllä.
:: Pojan hetu {{061207A8005|H}}, tarkista että se on oikein ennen kuin lähetät hakemuksen.
:: Rokotuskortissa lukee henkilötunnus {{100902A508L|H}}.
hetu-2023-separator :: Uudessa muodossa hetu on {{200258Y122D|H}}, eli viivan tilalla on nyt Y-kirjain.
hetu-2023-separator :: Henkilötunnus: {{250650X157X|H}} (uusi välimerkki X)
hetu-2023-separator :: Lääkärin lähetteessä potilaan tunnus oli {{220242W784X|H}}.
hetu-2023-separator :: Pankin lomake ei hyväksynyt hetua {{270690V350S|H}}, koska siinä on V-kirjain.
hetu-2023-separator :: Kirjasto rekisteröi asiakkaan hetulla {{190871U072B|H}}.
hetu-2023-separator :: Tyttären tunnus on {{231115B068S|H}}, siinä on uusi B-välimerkki.
hetu-2023-separator :: Hetu {{211009C699F|H}} kuuluu nuorimmalle, muut ovat vanhassa muodossa.
hetu-2023-separator :: Vauvan henkilötunnus on {{131122D357E|H}}, merkitse se neuvolakorttiin.
hetu-2023-separator :: Pojan passihakemus: henkilötunnus {{061011E121N|H}}, pituus 152 cm.
hetu-2023-separator :: Vaihto-oppilaan tunnus {{250506F1341|H}} tuli koulun kansliasta.
:: Sukututkimusarkistossa isoisoisän henkilötunnukseksi on merkitty {{280887+084N|H}}.
hetu-temporary :: Sairaala antoi väliaikaisen henkilötunnuksen {{150760-9703|H}}, koska hänellä ei ollut papereita mukana.
hetu-temporary :: Väliaikainen tunnus: {{050708A9707|H}}
hetu-temporary :: Potilaalle luotiin tilapäinen hetu {{230767-9458|H}} päivystyksessä.
hetu-temporary,hetu-2023-separator :: Tilapäinen henkilötunnus {{130493Y9198|H}} pitää vaihtaa pysyvään.
hetu-temporary :: Väliaikainen tunnus {{060355-929E|H}} löytyy potilastiedoista.
hetu-invalid :: Testissä käytin keksittyä tunnusta {{220450-498J|!H|väärä tarkistemerkki}}, eikä järjestelmä hyväksynyt sitä.
hetu-invalid :: Lomakkeen esimerkkikentässä lukee {{271061-2714|!H|väärä tarkistemerkki}}.
hetu-invalid :: Taulukossa on rivi {{100159-431J|!H|väärä tarkistemerkki}}, mutta tarkistemerkki ei täsmää.
hetu-invalid :: Kirjoitusvirhe: {{180689-581A|!H|väärä tarkistemerkki}} ei ole kelvollinen henkilötunnus.
hetu-invalid :: Asiakasnumero {{110394-881B|!H|väärä tarkistemerkki}} näyttää hetulta, mutta se on vain viitekoodi.
# --- IBAN
iban-spaced :: Vuokran voi maksaa tilille {{FI19 1238 9078 6666 17|I}}, viestiksi asunnon numero.
:: Tilinumeroni on {{FI0620960313721590|I}}, laita rahat sinne kun ehdit.
iban-spaced,swedish-finnish :: Saajan tili: {{FI10 3131 0928 1590 13|I}}, saaja {{Katja Lindqvist|P}}.
:: Muuta palkkatili muotoon {{FI0334096245957117|I}} ensi kuusta alkaen.
iban-spaced :: Pankkiyhteys: {{S-Pankki|O}}, {{FI59 3607 7741 2154 72|I}}.
iban-bban :: Vanha tilinumero oli {{40580385280841|I|||BBAN ilman FI-alkua}}, se on edelleen käytössä.
allative :: Lähetä {{Sanna Hyvöselle|P|Sanna Hyvönen||allatiivi}} 45 euroa tilille {{FI2247148525388853|I}}.
iban-spaced :: Lasku maksetaan tilille {{FI10 5009 3363 3875 00|I}}, eräpäivä 15.11.
:: Saatko tarkistettua, onko {{FI2153247439575513|I}} oikein? Maksu palautui.
iban-bban :: Tilinumero vanhassa muodossa: {{571137-35379907|I|||BBAN, viiva kuuden numeron jälkeen}}.
iban-spaced :: Siirrä säästöt tilille {{FI22 6005 1163 7265 16|I}} ennen vuodenvaihdetta.
:: Taloyhtiön vastikkeet maksetaan IBAN-tilille {{FI9766076122202972|I}}.
iban-bban :: Mummon tili on {{71782633043483|I|||BBAN ilman FI-alkua}}, kirjoitin sen ylös.
iban-spaced :: Jäsenmaksu: {{FI42 1036 8282 8807 29|I}}, viitenumero {{13579|!Z|viitenumero, ei postinumero}}.
:: Tarkistatko vielä tilin {{FI4822902227918058|I}} ennen kuin hyväksyt maksun?
iban-bban :: Kirjoitin lomakkeeseen vain {{395887-18033401|I|||BBAN, viiva kuuden numeron jälkeen}}, koska ohjeessa ei mainittu FI-alkua.
iban-foreign :: Ruotsalaisen kollegan tili on {{SE1650003726167513613412|I}}, laitan sinne puolet hotellilaskusta.
iban-foreign :: Virolainen remonttifirma pyysi ennakkomaksun tilille {{EE202232686563551505|I}}.
# --- phones
phone-international :: Soita minulle numeroon {{+358 40 718 2233|T}}, jos jotain sattuu.
phone-local,genitive :: {{Juhani Korhosen|P|Juhani Korhonen||genetiivi}} numero on {{040-5562190|T}}.
phone-local :: Uusi numeroni: {{0505839217|T}}
phone-local :: Ajanvaraus {{(09) 310 4471|T}}, arkisin 8–16.
phone-local :: Huoltoyhtiön päivystys {{09 2715 836|T}}, myös viikonloppuisin.
phone-international :: Toimiston vaihde {{+358-9-6224519|T}}.
phone-local,allative,place-vs-surname :: Tekstaa {{Pekka Lahdelle|P|Pekka Lahti||allatiivi}} numeroon {{044 912 3378|T}}.
phone-international,genitive :: Laita {{Sanna Hyvösen|P|Sanna Hyvönen||genetiivi}} numero ylös: {{+358 50 4417 920|T}}.
phone-local :: Mikä numero tämä on: {{045 671 2284|T}}? Soitti kolme kertaa.
phone-local :: Huoltomies vastaa numerosta {{0400 812 556|T}}.
phone-international :: Lähetä vahvistus tekstiviestillä numeroon {{+358447728301|T}}.
phone-local,genitive,swedish-finnish :: {{Leena Öhmanin|P|Leena Öhman||genetiivi}} työpuhelin on {{050-3311879|T}}.
phone-local :: Tampereen toimisto: {{(03) 245 6789|T}}.
phone-local :: Kampaamon numero on {{041 557 9012|T}}, varaa aika ennen joulua.
phone-international,swedish-finnish :: Varahenkilö: {{Erik Åkerlund|P}}, {{+358 45 230 9984|T}}
phone-local :: Isän numero on vaihtunut, uusi on {{0457823310|T}}.
phone-local :: Turun konttori {{(02) 274 1900|T}}, avoinna arkisin.
phone-local :: Lääkäriaseman takaisinsoitto tulee numerosta {{09-4512 776|T}}.
:: Tilausnumero {{4501 234 5678|!T|tilausnumero}}: tarkista toimituksen tila verkosta.
:: Paketin seurantanumero on {{040123456789012|!T|seurantanumero, 15 numeroa}}.
:: Arkistotunnus {{0401-2025-117|!T|arkistotunnus}} pitää merkitä jokaiseen liitteeseen.
# --- streets and postcodes
street-suffix-kuja :: Uusi osoitteeni on {{Koivukuja 5|A}}, {{02150 Espoo|Z}}.
address-inflected,street-suffix-tie :: Asun nykyään {{Mannerheimintiellä 12|A|Mannerheimintie 12||adessiivi}}, ylimmässä kerroksessa.
address-inflected,street-suffix-katu :: Hae paketti {{Kauppakadulta 3 B 14|A|Kauppakatu 3 B 14||ablatiivi, t > d}} ennen kuutta.
street-suffix-katu :: Toimiston osoite: {{Hämeenkatu 15|A}}, {{33100 Tampere|Z}}.
address-inflected,street-suffix-katu :: Juhlat ovat {{Hämeenkadulla 21 A 4|A|Hämeenkatu 21 A 4||adessiivi}} {{33100 Tampereella|Z|33100 Tampere||adessiivi}}.
address-inflected,street-suffix-polku :: Muutto {{Rantapolulle 7|A|Rantapolku 7||allatiivi, k > Ø}} on lauantaina, tarvitsen kantoapua.
street-suffix-polku :: Osoite: {{Rantapolku 9 C|A}}, {{40100 Jyväskylä|Z}}
address-inflected,street-suffix-väylä :: Varasto on {{Satamaväylällä 22|A|Satamaväylä 22||adessiivi}}, portti on auki seitsemään.
street-suffix-väylä :: Laskutusosoite on {{Itäväylä 4 B 18|A}}, {{00930 Helsinki|Z}}.
address-inflected,street-suffix-kaari :: Asumme {{Kalevankaarella 4|A|Kalevankaari 4||adessiivi}}, se keltainen rivitalo.
street-suffix-kaari :: Toimitusosoite: {{Kalevankaari 11 as 3|A}}, {{90100 Oulu|Z}}.
address-inflected,street-suffix-rinne :: Kerhohuone sijaitsee {{Myllyrinteellä 9|A|Myllyrinne 9||adessiivi, nn > nt}}.
street-suffix-rinne :: Uusi osoite: {{Myllyrinne 2 D 30|A}}, {{20100 Turku|Z}}.
address-inflected,street-suffix-raitti :: Kahvila on {{Kylänraitilla 3|A|Kylänraitti 3||adessiivi, tt > t}}, aivan torin vieressä.
street-suffix-raitti :: Lähetä kutsu osoitteeseen {{Kylänraitti 14|A}}, {{65100 Vaasa|Z}}.
address-inflected,street-suffix-ranta :: Venevaja on {{Pajarannassa 6|A|Pajaranta 6||inessiivi, nt > nn}}.
street-suffix-ranta :: Osoite: {{Pajaranta 18|A}}, {{70100 Kuopio|Z}}.
address-inflected,street-suffix-tori :: Tavataan {{Kauppatorilla 1|A|Kauppatori 1||adessiivi}} kello kymmenen.
street-suffix-tori :: Myymälän osoite on {{Kauppatori 3|A}}, {{28100 Pori|Z}}.
address-inflected,street-suffix-aukio :: Konsertti pidetään {{Kirkkoaukiolla 2|A|Kirkkoaukio 2||adessiivi}}.
street-suffix-aukio :: Toimipiste: {{Kirkkoaukio 5|A}}, {{53100 Lappeenranta|Z}}.
address-inflected,street-suffix-katu :: Pakettiautomaatti on {{Aleksanterinkatu 52:n|A|Aleksanterinkatu 52||genetiivi}} kohdalla.
street-suffix-tie,place-vs-surname :: Isän osoite on {{Puistotie 8|A}}, {{15110 Lahti|Z}}.
address-inflected,street-suffix-kuja :: Muutin pois {{Koivukujalta 5 A 2|A|Koivukuja 5 A 2||ablatiivi}} jo viime vuonna.
street-suffix-katu :: Uusi koti on {{Tuomiokirkonkatu 10 B|A}}, {{96100 Rovaniemi|Z}}.
address-inflected,street-suffix-polku :: Vie avain {{Pellavapolulle 3|A|Pellavapolku 3||allatiivi}} ja laita se postiluukusta.
address-inflected,street-suffix-raitti :: Ravintola löytyy {{Rantaraitilta 12|A|Rantaraitti 12||ablatiivi}}, ihan sataman vierestä.
address-inflected,street-suffix-rinne :: Neuvola on muuttanut {{Sairaalanrinteelle 4|A|Sairaalanrinne 4||allatiivi}}.
street-suffix-katu :: Posti menee osoitteeseen {{Torikatu 7 as 5|A}}, {{80100 Joensuu|Z}}.
address-inflected,street-suffix-tie :: Toimitus {{Teollisuustielle 19|A|Teollisuustie 19||allatiivi}}, {{01300 Vantaa|Z}}.
address-inflected,street-suffix-aukio :: Mielenosoitus siirtyi {{Asema-aukiolta 1|A|Asema-aukio 1||ablatiivi}} Kansalaistorille.
address-inflected,street-suffix-ranta :: Ajoin {{Merirantaan 15|A|Meriranta 15||illatiivi}}, mutta ketään ei ollut kotona.
:: Tilausnumero on {{48213|!Z|tilausnumero}}, jos asiakaspalvelu kysyy.
:: Remontti maksoi lopulta {{12500|!Z|rahasumma}} euroa, vähän yli budjetin.
:: Askelmittari näytti eilen {{10234|!Z|askelmäärä}} askelta.
:: Auto on ajettu {{98000|!Z|kilometrit}} kilometriä, hinta on neuvoteltavissa.
:: Asiakasnumeroni on {{55021|!Z|asiakasnumero}}, kirjaudu sillä palveluun.
# --- plates
plate-with-context :: Auton rekisterinumero on {{KTX-482|R}}, se on parkissa pihalla.
plate-with-context :: Rekkari {{JFU-71|R}}, onko se sinun autosi?
plate-with-context :: Pihalle on pysäköity valkoinen pakettiauto {{MKO-336|R}} jo kolmatta päivää.
plate-with-context :: Ilmoitin pysäköinninvalvontaan auton {{XYZ-98|R}}, joka tukkii portin.
plate-with-context :: Vuokra-auton rekisterinumero: {{LP-12|R}}
plate-with-context :: Kirjaa ajopäiväkirjaan auto {{RIK-904|R}}, ajettu 112 km.
plate-with-context :: Kuka pysäköi auton {{BOM-5|R}} meidän paikalle?
plate-with-context :: Myyn autoni, rekkari {{HVZ-118|R}}, katsastettu viime kuussa.
plate-no-context :: {{CGN-47|R}} ajoi taas ylinopeutta koulun ohi.
plate-no-context :: Näin aamulla {{OLY-650|R}} pihan perällä.
plate-no-context :: {{TEV-3|R}} oli taas samassa kohdassa.
plate-no-context :: Muistiinpano: {{SUV-21|R}} klo 7.40 portilla.
plate-decoy :: Varaston tuotekoodi {{SKU-123|!R|tuotekoodi}} on loppu.
plate-decoy :: Tilaa lisää osaa {{VKL-220|!R|tuotekoodi}}, sitä on hyllyssä B.
plate-decoy :: Projektin koodi {{PRJ-77|!R|projektikoodi}} pitää merkitä tuntikirjaukseen.
# --- place names and nouns that are also surnames
place-vs-surname,sentence-initial-common-noun :: {{Koski|!P|yleisnimi koski}} kuohui keväällä niin kovaa, ettei melomaan voinut lähteä.
place-vs-surname :: Ajetaan {{Lahden|!P|kaupunki Lahti}} kautta, niin ehditään syömään matkalla.
place-vs-surname :: {{Salo|!P|kaupunki Salo}} on suunnilleen puolivälissä Helsingin ja Turun välillä.
place-vs-surname,sentence-initial-common-noun :: {{Mäki|!P|yleisnimi mäki}} oli niin jäinen, että pyöräily oli mahdotonta.
place-vs-surname,sentence-initial-common-noun :: {{Järvi|!P|yleisnimi järvi}} jäätyi tänä vuonna jo marraskuussa.
place-vs-surname,sentence-initial-common-noun :: {{Niemi|!P|yleisnimi niemi}} on mökin kohdalla niin kapea, että molemmat rannat näkyvät.
place-vs-surname,sentence-initial-common-noun :: {{Saari|!P|yleisnimi saari}} näkyi sumun läpi vasta aamupäivällä.
place-vs-surname,sentence-initial-common-noun :: {{Ranta|!P|yleisnimi ranta}} oli helteellä täynnä ihmisiä.
place-vs-surname :: Vietämme viikonlopun {{Salossa|!P|kaupunki Salo}} sukulaisten luona.
place-vs-surname :: Muutin {{Lahteen|!P|kaupunki Lahti}} töiden perässä kaksi vuotta sitten.
place-vs-surname :: Kesämökki on {{Saaressa|!P|paikannimi}}, joten sinne pääsee vain veneellä.
place-vs-surname :: Tapaamispaikka on {{Niemen|!P|paikannimi}} uimarannan parkkipaikka.
place-vs-surname :: {{Timo Koski|P}} lähettää sopimuksen tänään iltapäivällä.
place-vs-surname :: Johtaja {{Mäki|P|Mäki||sukunimi tittelin kanssa}} ei päässyt paikalle, joten esitys siirtyi.
place-vs-surname,genitive :: Puhuin tohtori {{Niemen|P|Niemi||genetiivi, sukunimi tittelin kanssa}} kanssa koetuloksista.
place-vs-surname,genitive :: {{Marja Saaren|P|Marja Saari||genetiivi}} tarjous oli halvin, valitaan se.
place-vs-surname :: Opettaja {{Lahti|P|Lahti||sukunimi tittelin kanssa}} soitti ja kertoi, että retki peruttiin.
place-vs-surname,allative :: {{Kari Rannalle|P|Kari Ranta||allatiivi, nt > nn}} pitää muistaa kertoa uudesta aikataulusta.
place-vs-surname,genitive :: {{Elina Järven|P|Elina Järvi||genetiivi}} mukaan lupa myönnetään ensi viikolla.
place-vs-surname,ablative :: {{Johanna Salolta|P|Johanna Salo||ablatiivi}} tuli kiitosviesti.
place-vs-surname,allative :: Vuotavasta hanasta voi ilmoittaa isännöitsijä {{Koskelle|P|Koski||allatiivi, sukunimi tittelin kanssa}}.
place-vs-surname :: Kaavoituksesta vastaa {{Antti Niemi|P}}, ei {{Satu Mäki|P}}.
place-vs-surname,allative :: Rouva {{Saarelle|P|Saari||allatiivi, sukunimi tittelin kanssa}} kukat ja kortti, kiitos.
place-vs-surname,genitive :: Lääkäri {{Rannan|P|Ranta||genetiivi, sukunimi tittelin kanssa}} vastaanotto on toisessa kerroksessa.
place-vs-surname,adessive :: Kuulin, että {{Satu Mäellä|P|Satu Mäki||adessiivi, k > Ø}} on uusi työpaikka.
# --- no PII
no-pii,sentence-initial-common-noun :: Kauppa sulkeutuu tänään jo kuudelta, joten osta maito ennen sitä.
no-pii,sentence-initial-common-noun :: Sauna lämpiää, tule kun ehdit.
no-pii :: Huomenna sataa, ota sateenvarjo mukaan.
no-pii,capitalised-common-noun :: Muista ostaa {{Fazerin|O|Fazer}} Sinistä ja kahvia.
no-pii,sentence-initial-common-noun :: Kokous alkaa yhdeksältä, ja esityslista on jaetussa kansiossa.
no-pii,sentence-initial-common-noun :: Pesukone piippaa, joku voisi tyhjentää sen.
no-pii :: Tilasin {{Prismasta|O|Prisma}} ruokakassin, toimitus tulee seitsemältä.
no-pii :: Juna oli taas myöhässä, ja {{VR|O}} lupasi korvauksen.
no-pii,sentence-initial-common-noun :: Koira pitää viedä rokotukseen ennen kesää.
no-pii,sentence-initial-common-noun :: Lääke loppuu ensi viikolla, uusi resepti ajoissa.
no-pii,sentence-initial-common-noun :: Kevät tulee, ja pyörä pitää huoltaa.
no-pii,sentence-initial-common-noun :: Ruoka on uunissa, ota se pois puolen tunnin päästä.
no-pii,sentence-initial-common-noun :: Kirja pitää palauttaa kirjastoon perjantaihin mennessä.
no-pii :: Laajakaista vaihtuu {{Elisalle|O|Elisa}} ensi kuussa.
no-pii,sentence-initial-common-noun :: Talvirenkaat vaihdetaan lokakuun lopussa.
no-pii :: Mikä on hyvä resepti kasvislasagneen?
no-pii :: Onko {{Marimekon|O|Marimekko}} ale vielä voimassa?
no-pii,capitalised-common-noun :: Lento lähtee {{Finnairilla|O|Finnair}} kello 6.15, ole kentällä viimeistään viideltä.
no-pii,sentence-initial-common-noun :: Kahvinkeitin hajosi, tilaa uusi.
no-pii,capitalised-common-noun :: Joulupukki ja Tonttu-ukko ovat lasten mielestä parhaat joulukortit.
# --- emails
email :: Lähetä pöytäkirja osoitteeseen {{mikko.virtanen@gmail.com|E}}.
email :: Uusi sähköpostini on {{s.hyvonen@outlook.com|E}}, vanha poistuu käytöstä.
email,swedish-finnish :: Laita kopio myös {{katja.lindqvist@elisanet.fi|E}}, hän haluaa pysyä ajan tasalla.
# --- multi-entity texts
multi-entity,calendar :: Kalenterikutsu: Asuntonäyttö to 14.11. klo 17.00\nPaikka: {{Hämeenkatu 21 A 4|A}}, {{33100 Tampere|Z}}\nYhteyshenkilö: {{Jarmo Turkka|P}}, {{040 223 4410|T}}
multi-entity,calendar :: Kutsu: Projektin aloituspalaveri\nAika: ti 18.11. klo 13–14\nOsallistujat: {{Ville Heikkinen|P}}, {{Kirsi Lahtinen|P}}, {{Sami Toivonen|P}}\nPaikka: {{Satamaväylä 22|A}}, 2. krs
multi-entity,calendar,first-name-only :: Hammaslääkäri ma 3.11. klo 9.30, {{Kauppakatu 3 B 14|A}}. {{Päivi Järvinen|P}} vie lapset kouluun. Jos {{Päivi|P|Päivi|Päivi Järvinen|etunimi; viittaa edellisen lauseen Päivi Järviseen}} ei pääse, soita {{046 813 7720|T}}.
multi-entity,email-body,iban-spaced :: Hei {{Outi Kallio|P}},\nkiitos eilisestä. Lasku maksetaan tilille {{FI94 7159 9752 8820 01|I}}, viitenumero 1234 5. Kysy tarvittaessa lisää.\nTerveisin\n{{Tuomas Lehtonen|P}}\n{{tuomas.lehtonen@rakennuslehtonen.fi|E}}
multi-entity,email-body,swedish-finnish :: Moi,\nliitteenä {{Katja Lindqvistin|P|Katja Lindqvist||genetiivi}} hakemus. Hänen henkilötunnuksensa on {{140175-848J|H}} ja osoite {{Puistokatu 4 A 6|A}}, {{00100 Helsinki|Z}}.\nYst. terv. {{Heikki Nieminen|P}}
multi-entity,email-body,swedish-finnish,iban-spaced :: Hei,\nvahvistan, että {{Leena Öhman|P}} aloittaa meillä 1.12. Palkka maksetaan tilille {{FI34 5508 7801 7598 98|I}}. Postiosoite on {{Vanha Porvoontie 41|A}}, {{01380 Vantaa|Z}}.
multi-entity,email-body,allative :: Hei {{Juha Seppälä|P}},\nauto on yhä myynnissä. Rekisterinumero on {{ZYN-98|R}}, ja koeajosta voi sopia numerossa {{050 765 4321|T}}. Kirjoita mieluummin {{Juha Seppälälle|P|Juha Seppälä||allatiivi}} kuin minulle, hän hoitaa kaupat.
multi-entity,shopping-list :: Ostoslista:\n- maitoa\n- ruisleipää\n- kahvia\n- banaaneja\nToimitus: {{Linnankatu 44 B 7|A}}, {{20100 Turku|Z}}, ovikoodi 2468. Kuljettaja soittaa numeroon {{050 118 4499|T}}.
multi-entity,shopping-list :: Kauppalista {{Prismaan|O|Prisma}}: kananmunia, tomaatteja, kaurajuomaa.\nKotiinkuljetus: {{Rantaraitti 5 A 1|A}}, {{90570 Oulu|Z}}, vastaanottaja {{Henna Leppänen|P}}, {{+358 40 990 1145|T}}.
multi-entity,dialogue,nickname :: {{Sanna Hyvönen|P}}: Onko sulla {{Matti Laineen|P|Matti Laine||genetiivi}} numero?\nMinä: On, {{0442016655|T}}. {{Masa|P|Masa|Matti Laine|lempinimi; viittaa edellisen rivin Matti Laineeseen}} vaihtoi liittymää viime kuussa.
multi-entity,dialogue,plate-with-context,compound-name :: {{Mikko Virtanen|P}}: Kuka pysäköi pihaan auton {{GXL-260|R}}?\n{{Anna-Liisa Mäkelä|P}}: Se on {{Ville Heikkisen|P|Ville Heikkinen||genetiivi}} vuokra-auto, hän lähtee huomenna.
multi-entity,dialogue :: Asiakas: Hei, haluaisin päivittää tilinumeron.\nPalvelu: Mikä on uusi tilinumero?\nAsiakas: {{FI2881034788783848|I}}. Ja osoite on nyt {{Puistokatu 4 A 6|A}}, {{00100 Helsinki|Z}}.\nPalvelu: Kiitos, {{Olli Mattila|P}}. Tiedot on päivitetty.
multi-entity,calendar :: Ilmoittautuneet:\nNimi | Puhelin | Sähköposti\n{{Sari Laaksonen|P}} | {{046 813 7721|T}} | {{sari.laaksonen@gmail.com|E}}\n{{Ilkka Ahonen|P}} | {{040 552 0193|T}} | {{ilkka.ahonen@kolumbus.fi|E}}
multi-entity,email-body :: Muistilista:\n1) Maksa vuokra tilille {{FI3455087801759898|I}}? Ei, se on vanha tili, käytä {{FI0980095486205798|I}}.\n2) Soita {{Aino Ylöselle|P|Aino Ylönen||allatiivi}} numeroon {{041 702 3381|T}}.\n3) Vie avaimet {{Pellavapolku 3|A}}.
multi-entity,email-body,swedish-finnish :: Hei {{Tapio Söderström|P}},\ntässä pyytämäsi tiedot: henkilötunnus {{190547-575Y|H}}, tili {{FI1912389078666617|I}}, puhelin {{+358 40 718 2233|T}}.\nTerveisin {{Emma Grönroos|P}}
# --- English mixed in
english-mixed,allative :: Can you send the invoice to {{Mikko Virtaselle|P|Mikko Virtanen||allatiivi}}? Hänen sähköposti on {{mikko.virtanen@gmail.com|E}}.
english-mixed,swedish-finnish :: Meeting notes: {{Katja Lindqvist|P}} will handle the budget, ja {{Erik Åkerlundin|P|Erik Åkerlund||genetiivi}} kanssa sovitaan aikataulu next week.
english-mixed,phone-international :: My Swedish colleague's number is {{+46 70 123 45 67|T}}, voisitko lisätä sen kontakteihin?
english-mixed :: Please book a table for four, nimellä {{Hyvönen|P|Hyvönen|Sanna Hyvönen|sukunimi}}, at 7 pm.
english-mixed,genitive :: Forwarding this: {{Juhani Korhosen|P|Juhani Korhonen||genetiivi}} flight lands at 18:05, pick him up from Terminal 2.
english-mixed,allative :: Reminder to self: maksa {{Tiina Kokolle|P|Tiina Kokko||allatiivi}} 30 € konserttilipusta, IBAN {{FI2039588718033401|I}}.
english-mixed,iban-foreign,iban-spaced :: The Airbnb host in Berlin asked for payment to {{DE35 3704 0044 5242 7316 72|I}}, onko tämä turvallista?
english-mixed,allative,place-vs-surname :: Deadline moved, {{Pekka Lahti|P}} said it's fine, mutta {{Jarmo Turkalle|P|Jarmo Turkka||allatiivi}} pitää vielä kertoa.
english-mixed,multi-entity :: Shipping address: {{Aleksanterinkatu 17 C 9|A}}, {{00100 Helsinki|Z}}, Finland. Recipient: {{Tiina Hämäläinen|P}}, {{+358 41 702 3381|T}}.
english-mixed,ablative,double-surname :: Summarise this email from {{Riikka Virtanen-Koskiselta|P|Riikka Virtanen-Koskinen||ablatiivi}}: hän pyytää siirtämään katselmuksen perjantaille.
# --- code snippets with a Finnish name in a string literal
code-snippet :: const user = { name: "{{Mikko Virtanen|P}}", city: "Espoo", active: true };
code-snippet,compound-name :: customer = "{{Anna-Liisa Mäkelä|P}}"\nprint(f"Hei {customer}, laskusi on valmis")
code-snippet,email :: INSERT INTO asiakas (nimi, email) VALUES ('{{Ville Heikkinen|P}}', '{{ville.heikkinen@example.com|E}}');
code-snippet,allative :: expect(allative("{{Virtanen|P|Virtanen|Mikko Virtanen|testisyöte}}")).toBe("{{Virtaselle|P|Virtanen|Mikko Virtanen|allatiivi}}");
code-snippet,allative,swedish-finnish :: log.info("Lähetetään muistutus: %s", "{{Katja Lindqvistille|P|Katja Lindqvist||allatiivi}}")
# --- lower-case names, as typed on a phone (the first line is the 2026-10-25 incident sentence)
lowercase,genitive,inflected :: {{tiina heinon|P|Tiina Heino||genetiivi, pienet kirjaimet}} kanssa
lowercase,partitive,inflected :: en ole nähnyt {{tiina heinoa|P|Tiina Heino||partitiivi, pienet kirjaimet}} koko viikkona
lowercase,illative,inflected :: luotan {{tiina heinoon|P|Tiina Heino||illatiivi, pienet kirjaimet}} tässä asiassa
lowercase,allative,inflected,first-name-only :: soitin eilen {{tiinalle|P|Tiina|Tiina Heino|allatiivi, pelkkä etunimi}} ja sovittiin palaveri
lowercase,genitive,inflected,first-name-only :: {{juhanin|P|Juhani|Juhani Korhonen|genetiivi, pelkkä etunimi}} auto on taas korjaamolla
lowercase,genitive,inflected :: {{mikko virtasen|P|Mikko Virtanen||genetiivi, pienet kirjaimet}} kanssa sovittiin huomisesta
lowercase,allative,inflected :: laita viesti {{virtaselle|P|Virtanen|Mikko Virtanen|allatiivi, pelkkä sukunimi}} vielä tänään
lowercase,adessive,inflected :: kävin eilen {{korhosella|P|Korhonen|Juhani Korhonen|adessiivi, pelkkä sukunimi}} kahvilla
lowercase,nominative :: {{sanna hyvönen|P|Sanna Hyvönen||nominatiivi, pienet kirjaimet}} tulee huomenna käymään
lowercase,no-pii :: toivo on hyvä asia, ja onni potkaisi viime viikolla
lowercase,no-pii :: satu kertoi sadun, ja meri oli tyyni koko illan
lowercase,no-pii :: aino kerta kun se toimi oli max kaksi viikkoa sitten
# --- phase 12: phone-typed lower case without punctuation (c313-c362)
lowercase,phone-typed,allative,inflected :: moi voitko laittaa {{jukka salmiselle|P|Jukka Salminen||allatiivi, pienet kirjaimet}} viestin et palaveri siirtyy huomiseen
lowercase,phone-typed,allative,inflected :: soita {{mervi koskiselle|P|Mervi Koskinen||allatiivi, pienet kirjaimet}} kun ehdit se odottaa
lowercase,phone-typed,genitive,inflected :: {{antti lehtosen|P|Antti Lehtonen||genetiivi, pienet kirjaimet}} kanssa sovittiin et nähdään kahdelta
lowercase,phone-typed,partitive,inflected :: ootko nähny {{marko heikkistä|P|Marko Heikkinen||partitiivi, pienet kirjaimet}} tänään
lowercase,phone-typed :: {{riitta mäkinen|P|Riitta Mäkinen||nominatiivi, pienet kirjaimet}} soitti ja kysy sun numeroa
lowercase,phone-typed,adessive,inflected :: {{janne laaksosella|P|Janne Laaksonen||adessiivi, pienet kirjaimet}} on avaimet joten kysy siltä
lowercase,phone-typed,ablative,inflected :: kysy {{pirjo ahoselta|P|Pirjo Ahonen||ablatiivi, pienet kirjaimet}} onko kokous huomenna
lowercase,phone-typed,illative,inflected :: otin yhteyttä {{harri rantaseen|P|Harri Rantanen||illatiivi, pienet kirjaimet}} mut se ei vastannu
lowercase,phone-typed,genitive,inflected,place-vs-surname :: muista {{elina kosken|P|Elina Koski||genetiivi, pienet kirjaimet}} synttärit lauantaina
lowercase,phone-typed,allative,inflected :: laitoin {{sari virtaselle|P|Sari Virtanen||allatiivi, pienet kirjaimet}} kuvat mut se ei oo vielä kattonu
lowercase,phone-typed,genitive,first-name-only,swedish-finnish :: {{tommi lindroos|P|Tommi Lindroos||nominatiivi, pienet kirjaimet}} tulee kuudelta ja {{tommin|P|Tommi|Tommi Lindroos|genetiivi; viittaa samassa rivissä tommi lindroosiin}} auto on jo pihalla
lowercase,phone-typed,lone-surname,allative,inflected :: laita viesti {{heikkiselle|P|Heikkinen||allatiivi, pelkkä sukunimi}} et myöhästyn vähän
lowercase,phone-typed,lone-surname,genitive,inflected :: {{lehtosen|P|Lehtonen||genetiivi, pelkkä sukunimi}} mukaan työt alkaa maanantaina
lowercase,phone-typed,lone-surname,adessive,inflected :: kävin eilen {{salosella|P|Salonen||adessiivi, pelkkä sukunimi}} saunomassa
lowercase,phone-typed,lone-surname,ablative,inflected :: kysyin {{kettuselta|P|Kettunen||ablatiivi, pelkkä sukunimi}} mut se ei tienny mitään
lowercase,phone-typed,lone-surname,partitive,inflected :: en oo nähny {{hämäläistä|P|Hämäläinen||partitiivi, pelkkä sukunimi; myös yleisnimi hämäläinen}} koko viikkona
lowercase,phone-typed,lone-surname,allative,inflected,swedish-finnish :: soitin {{nyströmille|P|Nyström||allatiivi, pelkkä sukunimi}} ja se lupas tulla
lowercase,phone-typed,lone-surname,genitive,inflected :: {{pitkäsen|P|Pitkänen||genetiivi, pelkkä sukunimi}} kans puhuttiin pitkään
lowercase,phone-typed,first-name-only,allative :: sano {{jannelle|P|Janne||allatiivi, pelkkä etunimi}} et pelit on peruttu
lowercase,phone-typed,first-name-only,genitive :: {{minnan|P|Minna||genetiivi, pelkkä etunimi}} kanssa mennään kauppaan
lowercase,phone-typed,first-name-only,adessive :: {{jarilla|P|Jari||adessiivi, pelkkä etunimi}} on se peräkärry lainassa
lowercase,phone-typed,first-name-only,partitive :: muista onnitella {{kaisaa|P|Kaisa||partitiivi, pelkkä etunimi}} huomenna
lowercase,phone-typed,allative,inflected,swedish-finnish :: lähetä {{mikael lindholmille|P|Mikael Lindholm||allatiivi, pienet kirjaimet}} se tarjous
lowercase,phone-typed,genitive,inflected,swedish-finnish :: {{sofia ekströmin|P|Sofia Ekström||genetiivi, pienet kirjaimet}} lento laskeutuu seittemältä
lowercase,phone-typed,swedish-finnish :: {{henrik sjöberg|P|Henrik Sjöberg||nominatiivi, pienet kirjaimet}} ei pääse tänään
lowercase,phone-typed,nickname :: {{masa|P|Masa|Matti Laine|lempinimi, pienet kirjaimet}} tulee hakemaan sen kärryn huomenna
lowercase,phone-typed,nickname,allative :: kerro {{jussille|P|Jussi|Juhani Korhonen|lempinimi, allatiivi, pienet kirjaimet}} et kokous alkaa kolmelta
lowercase,phone-typed,first-name-only,genitive :: {{tiina kokko|P|Tiina Kokko||nominatiivi, pienet kirjaimet}} lähti jo ja {{tiinan|P|Tiina|Tiina Kokko|genetiivi; viittaa samassa rivissä tiina kokkoon}} kassi jäi tänne
lowercase,phone-typed,email :: laita kuvat {{pekka.niemi84@gmail.com|E}} niin tulostan ne
lowercase,phone-typed,email :: mun uus sposti on {{jenni.salo@hotmail.com|E}} vanha ei toimi
lowercase,phone-typed,street-suffix-kuja :: asun nykyään {{koivukuja 7 b 12|A|Koivukuja 7 b 12}} jos tuut käymään
lowercase,phone-typed,address-inflected,street-suffix-katu :: paketti pitää hakea {{kauppakadulta 14|A|Kauppakatu 14||ablatiivi}} ennen kuutta
lowercase,phone-typed,street-suffix-tie :: uus osote on {{rantatie 22 a 3|A|Rantatie 22 a 3}} {{40100 jyväskylä|Z|40100 Jyväskylä}}
lowercase,phone-typed,phone-local :: soita mulle {{0407713920|T}} ku oot perillä
lowercase,phone-typed,phone-local,genitive,inflected,place-vs-surname :: {{timo kosken|P|Timo Koski||genetiivi, pienet kirjaimet}} numero on {{050 449 1182|T}} jos tarviit
lowercase,phone-typed,multi-entity :: {{lauri mattila|P|Lauri Mattila||nominatiivi, pienet kirjaimet}} {{lauri.mattila@kolumbus.fi|E}} {{045 118 2290|T}}
lowercase,phone-typed,genitive,inflected :: ootko muistanu {{outi järvisen|P|Outi Järvinen||genetiivi, pienet kirjaimet}} lahjan
lowercase,phone-typed,essive,inflected :: {{hanna heinosena|P|Hanna Heinonen||essiivi, pienet kirjaimet}} se on vielä vanhoissa papereissa
lowercase,phone-typed,lone-surname,translative,inflected :: sen nimi vaihtu {{lahtiseksi|P|Lahtinen||translatiivi, pelkkä sukunimi}} häissä
lowercase,phone-typed,inessive,inflected :: {{jani nurmisessa|P|Jani Nurminen||inessiivi, pienet kirjaimet}} on potentiaalia
lowercase,phone-typed,elative,inflected :: mitä tiedät {{kari peltosesta|P|Kari Peltonen||elatiivi, pienet kirjaimet}} onko se luotettava
lowercase,phone-typed,lone-surname,abessive,inflected :: pärjätään kyllä {{virtasetta|P|Virtanen|Mikko Virtanen|abessiivi, pelkkä sukunimi}} tän yhden viikon
lowercase,phone-typed,first-name-only,clitic :: {{päivikö|P|Päivi||nominatiivi + -kö, pelkkä etunimi}} sen tilas vai joku muu
lowercase,phone-typed,no-pii :: tuuli yltyi illalla ja sade alko vasta yöllä
lowercase,phone-typed,no-pii :: voitto tuli jatkoajalla ja into oli kova koko illan
lowercase,phone-typed,no-pii :: lumi suli nopeesti ja kevät tuli aikasin
lowercase,phone-typed,no-pii :: ilona sain kuulla et se pääsi kouluun
lowercase,phone-typed,no-pii :: rauha ja hiljasuus on parasta mökillä
lowercase,phone-typed,no-pii :: valo palaa vielä keittiössä sammutatko sen
lowercase,phone-typed,genitive,inflected,swedish-finnish :: {{linnea holmströmin|P|Linnea Holmström||genetiivi, pienet kirjaimet}} kans mennään leffaan
# --- phase 12: Swedish-Finnish names (c363-c392)
swedish-finnish,allative,inflected :: Lähetin {{Mikael Lindholmille|P|Mikael Lindholm||allatiivi}} sopimuksen eilen illalla.
swedish-finnish,genitive,inflected :: {{Johan Nyströmin|P|Johan Nyström||genetiivi}} vene on myynnissä, kysy häneltä hintaa.
swedish-finnish :: {{Ebba Sundqvist|P}} aloittaa meillä maanantaina.
swedish-finnish,partitive,inflected :: Pyydä {{Fredrik Wikströmiä|P|Fredrik Wikström||partitiivi}} katsomaan sopimus läpi.
swedish-finnish,ablative,inflected :: Sain {{Annika Blomqvistilta|P|Annika Blomqvist||ablatiivi}} hyvän vinkin päiväkodista.
swedish-finnish,illative,inflected :: Luotan {{Kristian Lindroosiin|P|Kristian Lindroos||illatiivi}} näissä asioissa.
swedish-finnish,adessive,inflected :: {{Camilla Backmanilla|P|Camilla Backman||adessiivi}} on huomenna vapaapäivä.
swedish-finnish,essive,inflected :: Muistan hänet vielä {{Malin Granqvistina|P|Malin Granqvist||essiivi}}, ennen avioliittoa.
swedish-finnish,translative,inflected :: {{Ida Forsman|P}} vaihtoi sukunimensä {{Fagerströmiksi|P|Fagerström|Ida Forsman|translatiivi, uusi sukunimi}} kesällä.
swedish-finnish,inessive,inflected :: Minusta {{Patrik Holmbergissä|P|Patrik Holmberg||inessiivi}} on ainesta esihenkilöksi.
swedish-finnish,elative,inflected :: Mitä mieltä olet {{Stefan Lundqvistista|P|Stefan Lundqvist||elatiivi}}? Hän haki samaa paikkaa.
swedish-finnish,genitive,inflected :: {{Elin Strandbergin|P|Elin Strandberg||genetiivi}} hakemus tuli myöhässä, mutta se hyväksyttiin.
swedish-finnish,allative,inflected :: Kirjoita {{Henrik Westerlundille|P|Henrik Westerlund||allatiivi}}, että lasku on maksettu.
swedish-finnish,first-name-only :: {{Sofia Eriksson|P}} ja {{Jonas Karlsson|P}} tulevat yhdessä. {{Sofia|P|Sofia|Sofia Eriksson|etunimi; viittaa edellisen lauseen Sofia Erikssoniin}} ajaa.
swedish-finnish,genitive,inflected :: {{Ulf Johanssonin|P|Ulf Johansson||genetiivi}} mukaan kokous siirtyy ensi viikkoon.
swedish-finnish,partitive,inflected :: Ehdotin {{Linda Anderssonia|P|Linda Andersson||partitiivi}} uudeksi sihteeriksi.
swedish-finnish,allative,inflected :: Muistuta {{Mats Nymanille|P|Mats Nyman||allatiivi}} huomisesta tapaamisesta.
swedish-finnish,adessive,inflected :: {{Kristina Åbergilla|P|Kristina Åberg||adessiivi}} on kaikki tarvittavat paperit.
swedish-finnish,genitive,inflected :: {{Benita Öhbergin|P|Benita Öhberg||genetiivi}} puhelin on ollut kiinni koko päivän.
swedish-finnish,ablative,inflected,double-surname :: Kysy {{Anna Lindberg-Mäkiseltä|P|Anna Lindberg-Mäkinen||ablatiivi, kaksoissukunimi}}, onko sali varattu.
swedish-finnish,genitive,inflected,noble-name :: Puhuin eilen {{Carl von Hertzenin|P|Carl von Hertzen||genetiivi, aatelisnimi}} kanssa perunkirjoituksesta.
swedish-finnish,allative,inflected :: Soitin {{Jenny Holmströmille|P|Jenny Holmström||allatiivi}}, mutta hän ei vastannut.
swedish-finnish,illative,inflected :: Törmäsin {{Peter Lindqvistiin|P|Peter Lindqvist||illatiivi}} satamassa.
swedish-finnish,genitive,inflected :: {{Niklas Sjöblomin|P|Niklas Sjöblom||genetiivi}} auto on huollossa.
swedish-finnish,partitive,inflected :: Onnittelin {{Emilia Rosenbergiä|P|Emilia Rosenberg||partitiivi}} valmistumisesta.
swedish-finnish :: Ilmoittautuneet: {{Tobias Gustafsson|P}}, {{Wilma Lindholm|P}} ja {{Axel Nordström|P}}.
swedish-finnish,adessive,inflected :: {{Oskar Lindgrenillä|P|Oskar Lindgren||adessiivi}} on tieto siitä.
swedish-finnish,allative,inflected,email :: Laita {{Elsa Bergmanille|P|Elsa Bergman||allatiivi}} kopio osoitteeseen {{elsa.bergman@elisanet.fi|E}}.
swedish-finnish,lone-surname,genitive,inflected :: Puhuin {{Ekholmin|P|Ekholm||genetiivi, pelkkä sukunimi}} kanssa eilen.
swedish-finnish,lone-surname,allative,inflected :: Lähetä lasku {{Sundströmille|P|Sundström||allatiivi, pelkkä sukunimi}}.
# --- phase 12: nicknames (c393-c412)
nickname :: {{Markku Rantanen|P}} on taas paikalla. {{Make|P|Make|Markku Rantanen|lempinimi; viittaa edellisen lauseen Markku Rantaseen}} tuo kahvit.
nickname,allative :: {{Jaakko Mustonen|P}} muuttaa Tampereelle. Pidetään {{Jaskalle|P|Jaska|Jaakko Mustonen|lempinimi, allatiivi; viittaa edellisen lauseen Jaakko Mustoseen}} läksiäiset.
nickname :: {{Reijo Kinnunen|P}} soitti. {{Reiska|P|Reiska|Reijo Kinnunen|lempinimi; viittaa edellisen lauseen Reijo Kinnuseen}} haluaa lainata mönkijää.
nickname,genitive :: {{Tapio Hiltunen|P}} lähti kalaan. {{Tapsan|P|Tapsa|Tapio Hiltunen|lempinimi, genetiivi; viittaa edellisen lauseen Tapio Hiltuseen}} vene on rannassa.
nickname :: {{Katariina Lehtinen|P}} eli {{Kati|P|Kati|Katariina Lehtinen|lempinimi; viittaa samassa lauseessa Katariina Lehtiseen}} vastaa ilmoittautumisista.
nickname,allative :: {{Sakari Huttunen|P}} on lomalla. Kerro {{Sakelle|P|Sakke|Sakari Huttunen|lempinimi, allatiivi, kk > k; viittaa edellisen lauseen Sakari Huttuseen}}, kun hän palaa.
nickname :: {{Pentti Hirvonen|P}} täyttää 70. {{Pena|P|Pena|Pentti Hirvonen|lempinimi; viittaa edellisen lauseen Pentti Hirvoseen}} juhlii lauantaina.
nickname,partitive :: {{Liisa Turunen|P}} jää eläkkeelle. Muistetaan {{Lissua|P|Lissu|Liisa Turunen|lempinimi, partitiivi; viittaa edellisen lauseen Liisa Turuseen}} kukilla.
nickname :: {{Väinö Pesonen|P}} ajaa kuorma-autoa. {{Väiski|P|Väiski|Väinö Pesonen|lempinimi; viittaa edellisen lauseen Väinö Pesoseen}} tuntee kaikki tiet.
nickname,adessive :: {{Ari Savolainen|P}} lupasi auttaa. {{Arskalla|P|Arska|Ari Savolainen|lempinimi, adessiivi; viittaa edellisen lauseen Ari Savolaiseen}} on peräkärry.
nickname :: {{Teemu Laitinen|P}} pelaa sählyä. {{Teme|P|Teme|Teemu Laitinen|lempinimi; viittaa edellisen lauseen Teemu Laitiseen}} on aina ensimmäisenä paikalla.
nickname,genitive :: {{Anna Kauppinen|P}} on uusi esihenkilö. {{Anskun|P|Ansku|Anna Kauppinen|lempinimi, genetiivi; viittaa edellisen lauseen Anna Kauppiseen}} ensimmäinen päivä on maanantaina.
nickname,allative :: {{Simo Räsänen|P}} hoitaa grillin. Anna {{Simppalle|P|Simppa|Simo Räsänen|lempinimi, allatiivi, pp > p; viittaa edellisen lauseen Simo Räsäseen}} sytytysneste.
nickname :: {{Lauri Mattila|P}} tuli jo. {{Late|P|Late|Lauri Mattila|lempinimi, ei lempinimitaulukossa; viittaa edellisen lauseen Lauri Mattilaan}} odottaa autossa.
nickname :: {{Kirsi Moilanen|P}} vetää kokousta. {{Kirre|P|Kirre|Kirsi Moilanen|lempinimi; viittaa edellisen lauseen Kirsi Moilaseen}} lähettää muistion.
nickname,allative :: {{Elina Korpela|P}} on sairaana. Toivotetaan {{Ellille|P|Elli|Elina Korpela|lempinimi, allatiivi; viittaa edellisen lauseen Elina Korpelaan}} pikaista paranemista.
nickname :: {{Hannu Leinonen|P}} korjasi auton. {{Hanski|P|Hanski|Hannu Leinonen|lempinimi; viittaa edellisen lauseen Hannu Leinoseen}} ei ottanut maksua.
nickname :: {{Pirkko Ojala|P}} leipoi pullat. {{Pirkkis|P|Pirkkis|Pirkko Ojala|lempinimi, ei lempinimitaulukossa; viittaa edellisen lauseen Pirkko Ojalaan}} on paras leipuri.
nickname,genitive :: {{Seppo Vainio|P}} lähti jo. {{Sepin|P|Sepi|Seppo Vainio|lempinimi, genetiivi; viittaa edellisen lauseen Seppo Vainioon}} takki jäi naulakkoon.
nickname,lowercase,phone-typed :: {{veikko hakala|P|Veikko Hakala||nominatiivi, pienet kirjaimet}} soitti ja {{veke|P|Veke|Veikko Hakala|lempinimi, pienet kirjaimet; viittaa samassa rivissä veikko hakalaan}} tulee illalla
# --- phase 12: emails (c413-c437)
email :: Lähetä laskut osoitteeseen {{liisa.kallio@gmail.com|E}}, kiitos.
email :: Uusi osoitteeni on {{jarmo.t1974@gmail.com|E}}.
email :: Kirjoita {{s.nieminen@hotmail.com|E}}, hän vastaa yleensä illalla.
email :: Työosoite: {{tiina.kettunen@rakennusliikekettunen.fi|E}}
email,email-inflected :: Kirjoitin eilen {{tuomas.lehtonen@rakennuslehtonen.fi|E}}:hin, mutta vastausta ei ole tullut.
email,email-inflected :: Lähetin kutsun {{outi.kallio@outlook.com|E}}:iin ja kopion sinulle.
email :: Hänen vanha osoitteensa {{pirjo.ahonen@luukku.com|E}} ei enää toimi.
email :: Laita kopio myös {{kari.ranta@saunalahti.fi|E}}, hän on mukana hankkeessa.
email,multi-entity :: Yhteystiedot: {{Henna Leppänen|P}}, {{henna.leppanen@kiinteistohuoltoleppanen.fi|E}}, {{040 772 1934|T}}.
email,swedish-finnish :: {{Leena Öhman|P}} <{{leena.ohman@elisanet.fi|E}}> lisäsi sinut ryhmään.
email :: Muuta sähköpostiksi {{Kirsi.Lahtinen@Tilitoimistolahtinen.fi|E}}, vanha ei ole käytössä.
email :: Laskut voi ohjata osoitteeseen {{antti.niemi+laskut@gmail.com|E}}.
email,code-snippet :: {"nimi": "{{Ville Heikkinen|P}}", "email": "{{ville.heikkinen@yritys.fi|E}}"}
email :: Opiskelijan osoite on {{matias.korhonen@tuni.fi|E}}, lähetä tiedote sinne.
email :: Kaupungin yhteyshenkilö: {{sari.laaksonen@hel.fi|E}}.
email :: Lähetä vahvistus osoitteeseen {{JUHA.SEPPALA@KOLUMBUS.FI|E}}, hän kirjoittaa aina isoilla.
email,email-inflected :: Etsin viestiä {{marjut.heino@suomi24.fi|E}}:stä, se tuli viime viikolla.
email :: Lähetä kuittikopio {{jukka.salminen@pp.inet.fi|E}}.
email :: Isän osoite on {{reijo.karjalainen@netti.fi|E}}.
email,email-decoy :: Kuvatiedosto on {{logo@2x.png|!E|tiedostonimi, ei sähköposti}}, älä pienennä sitä.
email,email-decoy :: Tallenna ikoni nimellä {{ikoni@3x.webp|!E|tiedostonimi, ei sähköposti}}.
email,email-decoy :: Merkitse hänet ryhmäkeskusteluun muodossa {{@kirsi|!E|käyttäjätunnus ilman verkkotunnusta}}.
email,multi-entity :: {{Aino Ylönen|P}} ({{aino.ylonen@gmail.com|E}}) ja {{Eero Pöyhönen|P}} ({{eero.poyhonen@outlook.com|E}}) ilmoittautuivat.
email :: Sähköposti: {{h.virtanen-koskinen@kolumbus.fi|E}}
email,english-mixed :: Please cc {{katja.lindqvist@tilitoimisto.fi|E}} on the invoice, kiitos.
# --- phase 12: street addresses (c438-c472)
street-suffix-kaarre :: Uusi osoitteemme on {{Lehtikaarre 4 B 9|A}}, {{02210 Espoo|Z}}.
street-suffix-kaarre,address-inflected :: Asumme {{Lehtikaarteella 4|A|Lehtikaarre 4||adessiivi}}, mutta muutamme keväällä.
street-suffix-piha :: Toimitus osoitteeseen {{Sepänpiha 3 A 5|A}}, {{33500 Tampere|Z}}.
street-suffix-piha,address-inflected :: Hän asuu {{Sepänpihalla 3|A|Sepänpiha 3||adessiivi}}, keltaisessa talossa.
street-suffix-portti :: Lähetä paketti osoitteeseen {{Sammonportti 7 C 21|A}}, {{90230 Oulu|Z}}.
street-suffix-portti,address-inflected :: Varasto on {{Sammonportilla 7|A|Sammonportti 7||adessiivi, tt > t}}.
street-suffix-katu,address-inflected :: Muutimme {{Kalevankadulle 31|A|Kalevankatu 31||allatiivi}} viime kuussa.
street-suffix-tie :: Laskutusosoite: {{Pihlajatie 18 as. 4|A}}, {{00270 Helsinki|Z}}.
street-suffix-kuja,address-inflected :: Asun {{Tervakujalla 2 D 40|A|Tervakuja 2 D 40||adessiivi}} kolmannessa kerroksessa.
street-suffix-polku :: Postit tulevat osoitteeseen {{Kanervapolku 6|A}}, {{15140 Lahti|Z}}.
street-suffix-väylä,address-inflected :: Kokous pidetään {{Kauppaväylällä 9|A|Kauppaväylä 9||adessiivi}} toimiston neuvotteluhuoneessa.
street-suffix-rinne,address-inflected :: Ajoin {{Kuusirinteelle 11|A|Kuusirinne 11||allatiivi}}, mutta ovi oli lukossa.
street-suffix-ranta,address-inflected :: Mökki on {{Järvirannassa 3|A|Järviranta 3||inessiivi, nt > nn}}, aivan uimarannan vieressä.
street-suffix-tori,address-inflected :: Myyntikoju on {{Asematorilla 2|A|Asematori 2||adessiivi}} lauantaisin.
street-suffix-aukio :: Toimiston osoite: {{Tähtiaukio 1 B|A}}, {{20100 Turku|Z}}.
street-suffix-raitti,address-inflected :: Kahvila muutti {{Puistoraitille 8|A|Puistoraitti 8||allatiivi, tt > t}}.
street-suffix-kaari :: Uusi kotiosoite on {{Revontulenkaari 15 A 2|A}}, {{96400 Rovaniemi|Z}}.
street-suffix-tie,address-inflected :: Auto on parkissa {{Mannerheimintiellä 40|A|Mannerheimintie 40||adessiivi}}, hotellin edessä.
street-suffix-katu,address-inflected :: Hain lapset {{Koulukadulta 6|A|Koulukatu 6||ablatiivi}} kolmelta.
street-suffix-katu :: Osoite on {{Rautatienkatu 21 B 33|A}}, {{65100 Vaasa|Z}}, toinen kerros.
swedish-finnish,address :: Kesämökin osoite: {{Strandvägen 12|A|Strandvägen 12||ruotsinkielinen kadunnimi}}, {{10600 Ekenäs|Z}}.
street-suffix-polku,address-inflected :: Vie avaimet {{Kanervapolulle 6|A|Kanervapolku 6||allatiivi, k > Ø}} postilaatikkoon.
street-suffix-katu,email-body :: Hei,\ntoimitusosoite on {{Satakunnankatu 18 A 7|A}}, {{33210 Tampere|Z}}.\nTerveisin {{Mira Lehtola|P}}
address-decoy :: Ruuhka alkaa {{Valtatie 4|!A|tienumero, ei osoite}}:llä Lahden kohdalla.
address-decoy :: Käänny {{Kantatie 51|!A|tienumero, ei osoite}}:lle Karjaan risteyksessä.
address-decoy :: Remontti sulkee {{Seututie 110|!A|tienumero, ei osoite}}:n koko kesäksi.
street-suffix-katu,address-inflected :: Pakettiautomaatti on {{Hämeenkadun 25|A|Hämeenkatu 25||genetiivi}} kulmassa.
street-suffix-kuja :: Mummon uusi osoite: {{Haapakuja 1 as 2|A}}, {{80140 Joensuu|Z}}.
street-suffix-tie,multi-entity :: Kuljetus: {{Teollisuustie 33|A}}, {{01510 Vantaa|Z}}. Vastaanottaja {{Jari Hakkarainen|P}}, {{044 553 2810|T}}.
street-suffix-katu,english-mixed :: Ship it to {{Fredrikinkatu 48 C 12|A}}, {{00100 Helsinki|Z}}, Finland.
street-suffix-tie,address-inflected,lowercase,phone-typed :: oon {{koulutiellä 3|A|Koulutie 3||adessiivi, pienet kirjaimet}} odottamassa
street-suffix-ranta,lowercase,phone-typed :: osote on {{merenranta 9 b|A|Merenranta 9 b}} ihan sataman vieressä
street-suffix-katu,lowercase,phone-typed :: tuu {{puistokatu 12|A|Puistokatu 12}} ovikoodi on 1234
street-suffix-katu :: Asunto sijaitsee osoitteessa {{Isokatu 26 a 14|A}}.
street-suffix-piha,lowercase,phone-typed :: kerhohuone on {{myllypiha 2|A|Myllypiha 2}} sisäpihan perällä
# --- phase 12: decoys and lines without PII (c473-c492)
no-pii,sentence-initial-common-noun :: Toivo on tärkeää, kun odottaa tuloksia.
no-pii,sentence-initial-common-noun :: Lumi sulaa viimeistään huhtikuussa.
no-pii,sentence-initial-common-noun :: Tuuli kääntyi pohjoiseen iltapäivällä.
no-pii,sentence-initial-common-noun :: Rauha laskeutui taloon, kun lapset nukahtivat.
no-pii :: Ostin {{Stockmannilta|O|Stockmann}} uuden takin alennuksesta.
no-pii :: {{Hartwallin|O|Hartwall}} lonkeroa oli tarjouksessa.
no-pii :: Tilasin {{Fiskarsin|O|Fiskars}} kirveen verkkokaupasta.
no-pii :: Vaihdoin liittymän {{Telialle|O|Telia}}, koska hinta oli parempi.
no-pii :: Liput ostettiin {{Finnkinosta|O|Finnkino}}.
place-vs-surname :: Kävimme viikonloppuna {{Kotkassa|!P|kaupunki Kotka}} katsomassa merta.
place-vs-surname :: {{Porin|!P|kaupunki Pori}} jazzit ovat taas heinäkuussa.
place-vs-surname :: Juna {{Kouvolaan|!P|kaupunki Kouvola}} lähtee puoli tuntia myöhässä.
place-vs-surname :: Muutimme {{Raumalle|!P|kaupunki Rauma}} kolme vuotta sitten.
place-vs-surname :: Kesäloma vietetään {{Kuusamossa|!P|kunta Kuusamo}}.
place-vs-surname,sentence-initial-common-noun :: {{Kallio|!P|yleisnimi kallio}} oli liukas sateen jälkeen.
place-vs-surname,sentence-initial-common-noun :: {{Laakso|!P|yleisnimi laakso}} täyttyi sumusta aamulla.
no-pii :: Kokous on {{Teamsissa|O|Teams}} kello kymmenen.
no-pii,capitalised-common-noun :: Joulupukin Pajakylä on avoinna joka päivä.
no-pii :: Viitenumero {{1234 5678 9012|!T|viitenumero}} pitää muistaa maksaessa.
no-pii,lowercase,phone-typed :: kaikki meni hyvin ja onni oli matkassa
# --- phase 12: multi-entity texts (c493-c512)
multi-entity,calendar,swedish-finnish :: Kokous ke 12.11. klo 10\nPaikka: {{Kalevankatu 31|A}}, {{00100 Helsinki|Z}}\nOsallistujat: {{Mikael Lindholm|P}}, {{Riitta Mäkinen|P}}, {{Janne Laaksonen|P}}
multi-entity,email-body,first-name-only :: Hei {{Pirjo|P|Pirjo|Pirjo Ahonen|etunimi tervehdyksessä}},\nkiitos tapaamisesta. Lähetän sopimuksen osoitteeseen {{pirjo.ahonen@luukku.com|E}}.\nTerveisin\n{{Harri Rantanen|P}}
multi-entity,dialogue,swedish-finnish,adessive,inflected :: {{Sofia Ekström|P}}: Onko {{Johan Nyströmillä|P|Johan Nyström||adessiivi}} vielä se pakettiauto?\nMinä: On, soita hänelle {{040 663 1209|T}}.
multi-entity,shopping-list,swedish-finnish :: Kauppalista:\n- leipää\n- juustoa\n- kahvia\nToimitus {{Tervakuja 2 D 40|A}}, vastaanottaja {{Linnea Holmström|P}}, {{050 227 4416|T}}
multi-entity,email-body,iban-spaced :: Hei {{Antti Lehtonen|P}},\nvuokra maksetaan tilille {{FI35 1590 3000 0097 36|I}}. Kuitti osoitteeseen {{antti.lehtonen@gmail.com|E}}.
multi-entity :: Hakija: {{Kimmo Lahtinen|P}}, henkilötunnus {{120584-347M|H}}, osoite {{Pihlajatie 18 as. 4|A}}.
multi-entity,lowercase,phone-typed :: {{sari virtanen|P|Sari Virtanen||nominatiivi, pienet kirjaimet}} {{sari.virtanen@outlook.com|E}} {{rantatie 22 a 3|A|Rantatie 22 a 3}} {{0442710938|T}}
multi-entity,swedish-finnish,email :: Yhteyshenkilöt: {{Fredrik Wikström|P}} ({{fredrik.wikstrom@varvet.fi|E}}) ja {{Annika Blomqvist|P}} ({{040 815 2299|T}}).
multi-entity,calendar,nickname :: Saunailta pe klo 18\nPaikka: {{Sepänpiha 3 A 5|A}}\nTulossa: {{Markku Rantanen|P}} ja {{Pentti Hirvonen|P}} vaimoineen. {{Make|P|Make|Markku Rantanen|lempinimi; viittaa samassa viestissä Markku Rantaseen}} tuo makkarat.
multi-entity,english-mixed,swedish-finnish :: Meeting with {{Stefan Lundqvist|P}} at {{Fredrikinkatu 48 C 12|A}}, contact {{stefan.lundqvist@gmail.com|E}} or {{+358 40 553 1876|T}}.
multi-entity,email-body,iban :: Hei,\nuuden työntekijän tiedot: {{Mira Lehtola|P}}, {{mira.lehtola@tilitoimistolahtinen.fi|E}}, aloitus 1.12.\nPalkkatili {{FI2547081234567811|I}}.
multi-entity,code-snippet,swedish-finnish :: users = [{"name": "{{Elin Strandberg|P}}", "email": "{{elin.strandberg@gmail.com|E}}"}, {"name": "{{Oskar Lindgren|P}}", "email": "{{oskar.lindgren@yritys.fi|E}}"}]
multi-entity,first-name-only,ablative :: {{Kaisa Partanen|P}} ja {{Mervi Koskinen|P}} järjestävät myyjäiset. {{Kaisalta|P|Kaisa|Kaisa Partanen|ablatiivi; viittaa edellisen lauseen Kaisa Partaseen}} saa arvat ja {{Merviltä|P|Mervi|Mervi Koskinen|ablatiivi; viittaa edellisen lauseen Mervi Koskiseen}} pullat.
multi-entity,address-inflected,street-suffix-kuja,street-suffix-katu :: Muutin {{Koivukujalta 7|A|Koivukuja 7||ablatiivi}} {{Kalevankadulle 31|A|Kalevankatu 31||allatiivi}}, uusi numeroni on {{045 990 2283|T}}.
multi-entity,dialogue,lowercase,phone-typed :: minä: missä {{janne|P|Janne||etunimi, pienet kirjaimet}} on\n{{riitta|P|Riitta||etunimi, pienet kirjaimet}}: se meni {{laaksosille|P|Laaksonen||monikon allatiivi, pienet kirjaimet}} saunaan
multi-entity,swedish-finnish :: Potilas: {{Benita Sjöholm|P}}, {{030791-6180|H}}, puh. {{+358 50 337 2915|T}}.
multi-entity,email,nickname,ablative :: {{Jaakko Mustonen|P}} ({{jaska.mustonen@gmail.com|E}}) hoitaa ilmoittautumiset. {{Jaskalta|P|Jaska|Jaakko Mustonen|lempinimi, ablatiivi; viittaa edellisen lauseen Jaakko Mustoseen}} saa lisätietoja.
multi-entity,iban,allative,inflected :: Maksu {{Veera Kettuselle|P|Veera Kettunen||allatiivi}} tilille {{FI0857293847561027|I}}, viestiksi "{{Väinö Pesonen|P}} jäsenmaksu".
multi-entity :: Varahenkilöt: {{Ari Savolainen|P}} {{040 118 7720|T}}, {{Liisa Turunen|P}} {{050 448 1932|T}}.
multi-entity,email :: Laskutus: {{Revontulenkaari 15 A 2|A}}, {{96400 Rovaniemi|Z}}, {{laskutus@revontulirakennus.fi|E}}.
"""

MARK = re.compile(r"\{\{(.+?)\}\}")
HETU_CHARS = "0123456789ABCDEFHJKLMNPRSTUVWXY"


def iban_check(cc: str, bban: str) -> str:
    digits = "".join(str(int(c, 36)) for c in bban + cc + "00")
    return f"{98 - int(digits) % 97:02d}"


def canon(kind: str, surface: str) -> str:
    if kind == "HETU" or kind == "PLATE":
        return surface.upper()
    if kind == "EMAIL":
        return surface.lower()
    if kind == "IBAN":
        s = re.sub(r"[\s-]", "", surface).upper()
        return "FI" + iban_check("FI", s) + s if s[0].isdigit() else s
    if kind == "PHONE":
        d = re.sub(r"\D", "", surface)
        if surface.startswith("+"):
            return "+" + d
        return "+358" + d[1:] if d.startswith("0") else d
    return surface


def u16(s: str) -> int:
    return len(s.encode("utf-16-le")) // 2


def parse(n: int, line: str) -> dict:
    tags, _, body = line.partition("::")
    body = body.strip().replace("\\n", "\n")
    text, spans, decoys, pos = "", [], [], 0
    for m in MARK.finditer(body):
        text += body[pos:m.start()]
        f = m.group(1).split("|")
        surface, k = f[0], f[1]
        start, end = u16(text), u16(text) + u16(surface)
        if k.startswith("!"):
            decoys.append({"start": start, "end": end, "kind": KINDS[k[1:]], "note": f[2] if len(f) > 2 else ""})
        else:
            f += [""] * (5 - len(f))
            kind = KINDS[k]
            given = f[2] or None
            c = canon(kind, surface)
            if given and kind not in ("PERSON", "ADDRESS", "POSTCODE_CITY", "ORG"):
                assert given == c, (n, given, c)
            span = {"start": start, "end": end, "kind": kind, "canonical": given or c, "note": f[4]}
            if kind == "PERSON":
                span["ref"] = f[3] or span["canonical"]
            spans.append(span)
        text += surface
        pos = m.end()
    text += body[pos:]
    assert "{{" not in text and "}}" not in text, n
    tag_list = [t.strip() for t in tags.split(",") if t.strip()]
    kinds = {s["kind"] for s in spans}
    for kind, tag in (("HETU", "hetu"), ("IBAN", "iban"), ("PHONE", "phone"), ("ADDRESS", "address"),
                      ("PLATE", "plate"), ("EMAIL", "email")):
        if kind in kinds and tag not in tag_list:
            tag_list.append(tag)
    if any(s["kind"] == "PERSON" and s["canonical"] != text_slice(text, s) for s in spans) and "inflected" not in tag_list:
        tag_list.append("inflected")
    rec = {"id": f"c{n:03d}", "text": text, "spans": spans, "tags": tag_list}
    if decoys:
        rec["decoys"] = decoys
    return rec


def text_slice(text: str, span: dict) -> str:
    b = text.encode("utf-16-le")
    return b[span["start"] * 2:span["end"] * 2].decode("utf-16-le")


def main() -> None:
    lines = [ln for ln in SRC.splitlines() if ln.strip() and not ln.startswith("#")]
    recs = [parse(i + 1, ln) for i, ln in enumerate(lines)]
    assert len(recs) == 512, len(recs)
    out = Path(__file__).with_name("corpus.jsonl")
    out.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in recs), encoding="utf-8")
    print(f"wrote {len(recs)} lines to {out}")


if __name__ == "__main__":
    main()

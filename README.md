# Productora: acceso con código, registro y pedidos

Página de una productora de eventos. Para entrar hay que tener un código que se pasa de boca en boca
(cada RRPP tiene el suyo). Después de registrarse, el cliente ve el catálogo y hace su pedido.
El dueño lo aprueba y recién ahí el cliente paga.

## Cómo funciona

**Para el cliente**

1. **Puerta:** escribe el código de un RRPP. Si en Ajustes activás "No tengo código", también puede entrar sin RRPP.
2. **Registro obligatorio:** nombre y apellido, Instagram, cumpleaños, teléfono con código de país (+54) y la
   casilla de consentimiento sobre el uso de sus datos. Si falta algo o está mal escrito, no avanza.
   Queda anotado en la lista del RRPP cuyo código usó, para esa fecha.
3. **Catálogo:** cada producto muestra el desglose precio + recargo = total. Elige cantidades y toca "Pedir".
4. **Pedido pendiente:** no paga todavía. La página le avisa que la producción lo va a revisar y se actualiza sola.
5. **Pago:** cuando el dueño lo aprueba, aparece el botón de Mercado Pago o los datos para transferir.
   Si lo rechaza, se le informa.
6. **Pagado:** ve el código del pedido para mostrar en la puerta junto con su DNI, y la dirección del lugar.

**Para el dueño** (`/admin`, con contraseña)

- **Pedidos:** los pendientes arriba, con botones para aprobar o rechazar. Tiene un botón para avisarle al cliente
  por WhatsApp con el mensaje ya escrito, y otro para marcar pagado (transferencias) o marcar el ingreso en la puerta.
  Se actualiza solo cada 20 segundos.
- **Productos:** crear, editar, cambiar precios, mostrar u ocultar. Arriba se cambia el recargo.
- **RRPP:** nombre, código único y activo/pausado, con cuántos anotó, cuántos pedidos trajo y cuánto se cobró.
- **Listas:** quiénes se anotaron con cada código, filtrando por fecha, y quiénes compraron. Se exporta a CSV.
- **Clientes:** toda la base (nombre, Instagram, cumpleaños, teléfono, RRPP), con buscador,
  "Cumpleaños de este mes" y exportación a CSV (se abre en Excel o Google Sheets).
- **Fiestas:** fechas, cupo, descripción y dirección (la dirección solo la ve quien pagó).
- **Ajustes:** textos de la puerta, edad mínima, entrar sin RRPP, cómo se cobra, alias/CBU,
  WhatsApp de la producción y el aviso de privacidad.

## Correrlo en tu computadora

1. Instalá [Node.js](https://nodejs.org) **22.13 o superior** (la versión "LTS" sirve).
2. En la carpeta del proyecto: `npm install`
3. Copiá el archivo `.env.example` con el nombre `.env` y escribí una contraseña en `ADMIN_PASSWORD`.
4. `npm start` y abrí **http://localhost:3000**. El código inicial es `MEDIANOCHE`.

## Entrar al panel

Abrí **http://localhost:3000/admin** y poné la contraseña de `ADMIN_PASSWORD`.
Si esa variable no está configurada, el panel queda desactivado (la contraseña nunca va en el código).

## Primeros pasos en el panel

1. **RRPP:** ya viene uno llamado "General" con el código `MEDIANOCHE`, que funciona como código general.
   Para sumar un RRPP, en la pestaña **RRPP** poné su nombre y su código (por ejemplo `JULI`) y tocá
   **Guardar RRPP**. Pasale ese código: todos los que entren con él quedan en su lista.
2. **Productos:** ya están cargados Entrada VIP, Cabina y Combo botella, **sin precio y ocultos**. En la pestaña
   **Productos** tocá **Editar**, escribí el precio (`15000` o `15.000`) y tocá **Guardar producto**: queda visible.
   Para agregar otro, completá "Nuevo producto". El recargo (por defecto $1.000 por unidad) se cambia arriba.
3. **Fiestas:** editá "Noche de apertura" con la fecha y la dirección reales, o creá una nueva.
4. **Ajustes:** cargá el alias o CBU y el titular (o conectá Mercado Pago), el WhatsApp de la producción
   y revisá el aviso de privacidad.
5. **Probalo:** entrá a la página con un código, registrate y hacé un pedido. Después aprobalo en **Pedidos**.

## Cobros

- **Transferencia:** al aprobar, el cliente ve el monto, el alias/CBU y un botón para mandarte el comprobante
  por WhatsApp. Cuando te llega la plata, tocás **Marcar pagado**.
- **Mercado Pago:** cargá `MP_ACCESS_TOKEN` y `PUBLIC_URL` y elegí "Mercado Pago" en Ajustes. Al aprobar, el
  cliente tiene un botón para pagar el total exacto. Cuando paga, Mercado Pago le avisa a la página y el pedido
  pasa solo a **Pagado**; la página confirma el pago consultando a Mercado Pago, no se fía del aviso.
  Para ensayar usá las credenciales de prueba de tu cuenta de Mercado Pago.

## Variables de entorno

Van en el archivo `.env` (en tu computadora) o en la pestaña **Variables** de Railway. Nunca en el código.

| Variable | Para qué sirve |
| --- | --- |
| `ADMIN_PASSWORD` | Contraseña del panel. **Obligatoria.** |
| `MP_ACCESS_TOKEN` | Access Token de Mercado Pago. Opcional: sin él se cobra por transferencia. |
| `PUBLIC_URL` | Dirección pública, por ejemplo `https://mi-productora.up.railway.app`. Necesaria para Mercado Pago. |
| `INITIAL_CODE` | Código del RRPP "General" que se crea la primera vez (por defecto `MEDIANOCHE`). |
| `CLUB_NAME` | Nombre inicial del lugar (después se cambia en Ajustes). |
| `SESSION_SECRET` | Opcional: si no está, se genera una sola vez y se guarda en la base. |
| `DATA_DIR` | Carpeta de la base de datos (por defecto `./data`). |

## Base de datos

Es SQLite, que viene incluida en Node: un solo archivo, `data/productora.db`. Para hacer una copia de seguridad,
copiá ese archivo con la página apagada. Tablas:

| Tabla | Qué guarda |
| --- | --- |
| `clientes` | Cada persona registrada: nombre, Instagram, cumpleaños, teléfono (único), RRPP asignado, fecha en la que se registró y cuándo aceptó el uso de sus datos. |
| `rrpp` | Nombre, código único y si está activo. |
| `lista_rrpp` | Quién se anotó con qué RRPP para qué fecha (una vez por fecha: queda con el primer RRPP). |
| `productos` | Nombre, descripción, precio (sin recargo), visible u oculto y orden. |
| `pedidos` | Cliente, RRPP, fecha, estado (pendiente, aprobado, rechazado o pagado), total y datos del pago. |
| `pedido_items` | Qué se pidió: copia del nombre, precio y recargo del momento, cantidad y subtotal. |
| `configuracion` | Recargo, método de pago, datos de transferencia, textos y demás ajustes. |
| `eventos` | Las fiestas: fecha, cupo, descripción, dirección y si están abiertas. |

Si alguien se registra con un teléfono que ya existe, se reutiliza ese cliente, pero solo si coincide la fecha
de cumpleaños. Así nadie puede registrarse con el número de otra persona.

## Publicarlo en Railway

1. En [railway.app](https://railway.app): **New Project → Deploy from GitHub repo** y elegí este repositorio.
2. **Para no perder los datos:** en el servicio creá un **Volume** montado en `/data` y agregá la variable
   `DATA_DIR=/data`. Sin eso, cada nueva versión borra clientes y pedidos.
3. En **Variables** cargá `ADMIN_PASSWORD` (y si vas a usar Mercado Pago, `MP_ACCESS_TOKEN` y `PUBLIC_URL`).
4. En **Settings → Networking → Generate Domain** obtenés la dirección pública. Ponela también en `PUBLIC_URL`.

## Pruebas

`npm test` corre las pruebas automáticas del recorrido completo: validaciones, registro, RRPP, catálogo con
recargo, aprobación, pagos (con un Mercado Pago simulado), panel y seguridad.

## Estructura

```
server.js            Servidor y API (acceso, registro, catálogo, pedidos, pagos y panel)
db.js                Base de datos SQLite: tablas y datos iniciales
public/
  index.html         Puerta, registro, catálogo y pedidos
  club.js            Lógica de esas pantallas
  admin.html         Panel
  admin.js           Lógica del panel
  validar.js         Reglas de validación (las usan la página y el servidor)
  common.js          Funciones compartidas
  club.css           Estilos
test/api.test.js     Pruebas
.env.example         Modelo del archivo de variables
```

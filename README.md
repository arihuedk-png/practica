# Mi Tienda — tienda en línea con pedidos por WhatsApp

Tienda web completa: catálogo, carrito, pedidos por WhatsApp, pago en línea con Mercado Pago,
cuentas de clientes, seguimiento del pedido y panel de administración.

## Qué incluye

**Para los clientes** (`/`)
- Catálogo con categorías, buscador y productos destacados.
- Detalle de producto con cantidad y aclaraciones ("sin cebolla").
- Carrito que se guarda en el navegador.
- Checkout: envío a domicilio o retiro en el local, efectivo, transferencia o Mercado Pago.
- Al confirmar, el pedido se guarda y se abre WhatsApp con el mensaje del pedido ya armado.
- Página de seguimiento (`/pedido.html?id=…&t=…`) que se actualiza sola.
- Crear cuenta / iniciar sesión y ver "Mis pedidos".

**Para el dueño** (`/admin`)
- Resumen del día: pedidos, ventas y pendientes.
- Pedidos en tiempo real (se refrescan cada 20 s, con aviso sonoro), cambiar estado, marcar pagado, escribir al cliente por WhatsApp.
- Productos: crear, editar, ocultar, destacar y subir fotos.
- Categorías: crear, renombrar, ordenar y borrar.
- Ajustes: nombre, frase, WhatsApp, costo de envío, pedido mínimo, horario, datos de transferencia, color y abrir/cerrar la tienda.

## Cómo usarla en tu computadora

Necesitas [Node.js](https://nodejs.org) 20 o superior.

```bash
npm install
npm start
```

Abre http://localhost:3000 (tienda) y http://localhost:3000/admin (panel).

Usuario administrador por defecto: `admin@tienda.com` / `admin123`.
**Cámbialo** con las variables `ADMIN_EMAIL` y `ADMIN_PASSWORD` antes de publicar la tienda.
Estas variables solo se usan la primera vez, cuando se crea la base de datos.

Para correr las pruebas: `npm test`.

## Variables de entorno

| Variable | Para qué sirve |
| --- | --- |
| `PORT` | Puerto del servidor (Railway lo pone solo). |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Usuario administrador inicial. |
| `WHATSAPP_NUMBER` | Número que recibe los pedidos, con código de país y sin `+` (ej. `5215512345678`). También se puede cambiar desde el panel. |
| `STORE_NAME` | Nombre inicial de la tienda. |
| `CURRENCY` | Moneda para Mercado Pago (`MXN`, `ARS`, `COP`, `CLP`, `PEN`, `UYU`, `BRL`). |
| `MP_ACCESS_TOKEN` | Access token de Mercado Pago. Si está, aparece la opción "Pagar en línea". |
| `PUBLIC_URL` | URL pública (ej. `https://mitienda.up.railway.app`), para los links de pago y seguimiento. |
| `SESSION_SECRET` | Clave para firmar las sesiones (opcional; si no, se genera una). |
| `DATA_DIR` | Carpeta donde se guardan los datos y las fotos (por defecto `./data`). |

## Publicarla en Railway (como la página original)

1. Sube este repositorio a GitHub (ya lo está).
2. En [railway.app](https://railway.app): **New Project → Deploy from GitHub repo** y elige el repositorio.
   Railway detecta que es Node.js y ejecuta `npm start`.
3. **Importante, para no perder los datos:** en el servicio, crea un **Volume** montado en `/data`
   y agrega la variable `DATA_DIR=/data`. Sin esto, cada nuevo despliegue borra los pedidos, productos y fotos.
4. En **Variables**, agrega al menos `ADMIN_EMAIL`, `ADMIN_PASSWORD` y `WHATSAPP_NUMBER`
   (y `MP_ACCESS_TOKEN` si vas a cobrar en línea).
5. En **Settings → Networking → Generate Domain** obtienes una URL como `https://tu-tienda.up.railway.app`.
   Ponla también en `PUBLIC_URL`.

## Mercado Pago

1. Crea una aplicación en https://www.mercadopago.com/developers/panel y copia el **Access Token**
   (usa primero el de *prueba* para ensayar).
2. Configúralo en `MP_ACCESS_TOKEN` y pon `CURRENCY` con la moneda de tu país.
3. Cuando el cliente elige "Pagar en línea", se le envía al checkout de Mercado Pago. Al aprobarse el pago,
   Mercado Pago avisa a `/api/payments/webhook`, y el pedido queda como **pagado** y **confirmado**.

## Estructura

```
server.js          Servidor Express y API
db.js              Base de datos en un archivo JSON (data/db.json) + datos de ejemplo
public/
  index.html       Tienda
  app.js           Lógica de la tienda (catálogo, carrito, checkout, cuenta)
  pedido.html      Seguimiento del pedido
  admin.html       Panel de administración
  admin.js         Lógica del panel
  common.js        Funciones compartidas
  styles.css       Estilos
test/api.test.js   Pruebas de la API
```

Los productos de ejemplo (pizzas, empanadas…) se pueden cambiar o borrar desde el panel.

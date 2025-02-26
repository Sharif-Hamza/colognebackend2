import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Initialize Supabase client
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

// Configure CORS with specific options
app.use(cors({
  origin: process.env.FRONTEND_URL.replace(/\/$/, ''), // Remove trailing slash if present
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400 // Cache preflight request for 24 hours
}));

// Parse JSON payloads
app.use(express.json());

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Cologne Ologist API',
    status: 'running',
    endpoints: ['/create-checkout-session', '/checkout-session/:sessionId', '/webhook']
  });
});

// Create checkout session
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items, userId, email } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Invalid items data' });
    }

    const lineItems = items.map(item => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: item.name,
          description: item.description,
          images: [item.image_url],
          metadata: {
            productId: item.id,
            image_url: item.image_url // Store image URL in metadata
          }
        },
        unit_amount: item.price,
      },
      quantity: item.quantity,
    }));

    // Ensure the URL doesn't have double slashes
    const baseUrl = process.env.FRONTEND_URL.replace(/\/+$/, '');
    
    const session = await stripe.checkout.sessions.create({
      customer_email: email,
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/cart`,
      metadata: {
        userId
      },
      allow_promotion_codes: true,
      billing_address_collection: 'required',
      shipping_address_collection: {
        allowed_countries: ['US']
      }
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ 
      message: error.message || 'An error occurred while creating the checkout session'
    });
  }
});

// Retrieve session details
app.get('/checkout-session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items.data.price.product', 'customer_details', 'payment_intent']
    });

    // Get product details from Supabase for each line item
    const productIds = session.line_items.data.map(item => 
      item.price.product.metadata.productId
    );

    const { data: products } = await supabase
      .from('products')
      .select('id, image_url')
      .in('id', productIds);

    const productMap = products.reduce((acc, product) => {
      acc[product.id] = product;
      return acc;
    }, {});

    res.json({
      customer: {
        name: session.customer_details?.name || 'N/A',
        email: session.customer_details?.email || 'N/A'
      },
      items: session.line_items?.data.map(item => ({
        description: item.description,
        quantity: item.quantity,
        amount_total: item.amount_total,
        image_url: productMap[item.price.product.metadata.productId]?.image_url
      })) || [],
      total: session.amount_total
    });
  } catch (error) {
    console.error('Error retrieving session:', error);
    res.status(500).json({ message: 'Failed to retrieve order details' });
  }
});

// Webhook endpoint for handling Stripe events
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try {
      // Retrieve the session with line items
      const expandedSession = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ['line_items.data.price.product']
      });

      // Get product details from Supabase
      const productIds = expandedSession.line_items.data.map(item => 
        item.price.product.metadata.productId
      );

      const { data: products } = await supabase
        .from('products')
        .select('id, image_url')
        .in('id', productIds);

      const productMap = products.reduce((acc, product) => {
        acc[product.id] = product;
        return acc;
      }, {});

      // Create the order
      const { data: order, error: orderError } = await supabase
        .from('orders')
        .insert({
          id: session.id,
          user_id: session.metadata.userId,
          status: 'completed',
          total: session.amount_total,
        })
        .select()
        .single();

      if (orderError) throw orderError;

      // Create order items with product details
      const orderItems = expandedSession.line_items.data.map(item => ({
        order_id: order.id,
        product_id: item.price.product.metadata.productId,
        quantity: item.quantity,
        price_at_time: item.price.unit_amount,
        image_url: productMap[item.price.product.metadata.productId]?.image_url
      }));

      const { error: itemsError } = await supabase
        .from('order_items')
        .insert(orderItems);

      if (itemsError) throw itemsError;

      console.log('Order and items created successfully');
    } catch (error) {
      console.error('Error processing successful payment:', error);
      return res.status(500).json({ message: 'Error processing payment success' });
    }
  }

  res.json({ received: true });
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`CORS enabled for origin: ${process.env.FRONTEND_URL.replace(/\/$/, '')}`);
});
